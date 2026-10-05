"""T1 分軌前向影子（登錄 T1-TRACKS-FWD-2026-10-05）的 I/O 與時鐘工具：路徑、環境防呆、封印、只寫一次、期限、休市日曆。

不 import 任何釘選模組以外的研究程式；本檔不改變任何計算（接線程式，登錄 implementation_pins.not_pinned）。
  · 封印 seal＝sha256(canonical JSON，不含 seal 欄；sort_keys、ensure_ascii=False、separators=(',', ':')、allow_nan=False)。
  · 只寫一次：O_CREAT|O_EXCL 建檔（同名已存在＝拒寫；內容相同回 'same'、不同回 'conflict'，原檔不動）。
  · 期限：目標日 t 的 09:00（Asia/Taipei）；看資料、不看時鐘——時鐘只用來判「已過期限」。
  · 休市日曆：協調器（Firestore system/tradingCalendar ∪ 鏡像休市表）以 holidays／covered 年份傳入；平日落在未涵蓋年份就丟錯，不猜。
影子模式·未扣成本·非投資建議。
"""
import contextlib
import datetime
import gzip
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time

LAB = os.path.dirname(os.path.abspath(__file__))
MAIN_REPO = '/Users/gmii/Documents/股票助手app/tw-stock-app'           # 主 checkout：鏡像與釘住快取只讀
TZ = datetime.timezone(datetime.timedelta(hours=8))
FREEZE_HHMM = (9, 0)
SCHEMA_CORE = 't1-tracks-forward-core/v1'
SCHEMA_GAP = 't1-tracks-forward-gap/v1'
SCHEMA_SCORE = 't1-tracks-forward-score/v1'
SCHEMA_PARITY = 't1-tracks-forward-parity/v1'
SCHEMA_STATUS = 't1-tracks-forward-status/v1'
SCHEMA_PREWIRE = 't1-tracks-forward-prewire/v1'
KIND_CORE = 't1-tracks-core'
NOTE = '影子模式·未扣成本·事後欄位以 m_ 標示·非投資建議'
CONFIG_PATH = os.path.join(LAB, 'tracks', 'forward_config.json')
LOCK_DIR = os.path.join(LAB, '.a35_shadow_daily.lock')        # 與起漲影子協調器同一把鎖（排程與手動互斥）
FORBIDDEN_CACHES = ('.surge-cache', '.surge-cache-T', '.surge-cache-L', '.surge-cache-T2')
RESEARCH_ENV = ('SURGE_OFFICIAL_LIMIT', 'SURGE_REVENUE', 'SURGE_PIT_STRICT', 'SURGE_DATASET_SUFFIX')


class Refuse(Exception):
    """前置條件不成立：呼叫端記錄理由後停止（不是程式錯誤）。"""


# ───────────────────────── 路徑與環境 ─────────────────────────
def paths(env=None) -> dict:
    e = os.environ if env is None else env
    shared = e.get('SURGE_TRACKS_SHARED') or os.path.join(LAB, '.surge-cache')
    return dict(
        cache=os.path.realpath(e.get('SURGE_CACHE') or os.path.join(LAB, '.surge-cache-F')),
        shared=os.path.realpath(shared),
        official_root=os.path.realpath(e.get('OFFICIAL_ROOT') or os.path.join(MAIN_REPO, 'second-brain', 'official')),
        seed=os.path.realpath(e.get('SURGE_TRACKS_SEED') or os.path.join(MAIN_REPO, 'scripts', 'surge-lab', '.surge-cache-T')),
        out=os.path.realpath(e.get('SURGE_TRACKS_OUT') or os.path.join(LAB, 'out', 'tracks_fwd')),
    )


def guard_env(p: dict, env=None) -> None:
    """前向快取絕不可是共用／釘住／研究快取；研究用環境變數不可帶進來（官方漲停價改以參數傳入 compute_all）。"""
    e = os.environ if env is None else env
    leak = [k for k in RESEARCH_ENV if k in e]
    if leak:
        raise Refuse(f'研究用環境變數 {", ".join(leak)} 已設定：前向建置拒跑（官方漲停價以參數傳入，不經環境變數）')
    base = os.path.basename(p['cache'].rstrip('/'))
    if base in FORBIDDEN_CACHES or p['cache'] in (p['shared'], p['seed']):
        raise Refuse(f'SURGE_CACHE＝{p["cache"]} 是共用／釘住／研究快取：前向只寫專用的前向快取目錄')
    if os.path.realpath(e.get('SURGE_CACHE', '')) != p['cache']:
        raise Refuse('SURGE_CACHE 未設定或與前向快取不一致（研究模組在 import 時綁定 SURGE_CACHE）')


def load_config(path: str = CONFIG_PATH) -> dict:
    """總開關（磁碟即部署）：enabled＝false 時協調器與本程式都不凍結。檔案讀不到＝停用（不猜）。"""
    try:
        cfg = json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError) as e:
        return dict(enabled=False, startDay=None, error=f'讀不到 {path}：{e}')
    ok_day = isinstance(cfg.get('startDay'), str) and len(cfg['startDay']) == 10
    return dict(cfg, enabled=cfg.get('enabled') is True and ok_day)     # 只接受布林 true（與 surge-tracks-daily.parseForwardConfig 同規則）


# ───────────────────────── 鎖（與 a35_shadow_daily.mjs 相容：mkdir＋owner.json 的 pid）─────────────────────────
def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


@contextlib.contextmanager
def orchestrator_lock(lock_dir: str = LOCK_DIR):
    """協調器的子行程（鎖的持有者＝父行程）直接沿用；手動執行要自己拿同一把鎖，拿不到（有人在跑）就拒跑；持有者已死＝殘留鎖，回收。"""
    owner_path = os.path.join(lock_dir, 'owner.json')
    owner = read_json(owner_path)
    if owner and owner.get('pid') == os.getppid():
        yield 'parent'
        return
    for _ in range(2):
        try:
            os.mkdir(lock_dir)
        except FileExistsError:
            owner = read_json(owner_path)
            if owner and isinstance(owner.get('pid'), int) and _alive(owner['pid']):
                raise Refuse(f'另一輪正在執行（pid {owner["pid"]}，{owner.get("startedAt")}）：與起漲影子協調器共用鎖，本次不跑')
            shutil.rmtree(lock_dir, ignore_errors=True)
            continue
        write_json_atomic(owner_path, dict(pid=os.getpid(), startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                           host=socket.gethostname(), argv=['a37_tracks_fwd.py'] + sys.argv[1:]))
        break
    else:
        raise Refuse('取不到協調器鎖')
    try:
        yield 'mine'
    finally:
        o = read_json(owner_path)
        if o and o.get('pid') == os.getpid():
            shutil.rmtree(lock_dir, ignore_errors=True)


# ───────────────────────── 封印與只寫一次 ─────────────────────────
def canon_bytes(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def seal_of(obj: dict) -> str:
    return hashlib.sha256(canon_bytes({k: v for k, v in obj.items() if k != 'seal'})).hexdigest()


def sealed(obj: dict) -> dict:
    return dict(obj, seal=seal_of(obj))


def verify_seal(obj: dict) -> bool:
    return isinstance(obj.get('seal'), str) and obj['seal'] == seal_of(obj)


def write_once(path: str, obj: dict) -> str:
    """'written'｜'same'（已存在且逐位相同）｜'conflict'（已存在但內容不同：原檔不動，呼叫端記 parity 失敗）。"""
    data = canon_bytes(obj)
    if os.path.exists(path):
        return 'same' if open(path, 'rb').read() == data else 'conflict'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.link(tmp, path)                       # 原子「不存在才建立」（同名已存在丟 FileExistsError）
    except FileExistsError:
        os.unlink(tmp)
        return 'same' if open(path, 'rb').read() == data else 'conflict'
    os.unlink(tmp)
    return 'written'


def write_json_atomic(path: str, obj) -> None:
    """可覆寫的狀態檔（非凍結紀錄）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, allow_nan=False)
    os.replace(tmp, path)


def read_json(path: str):
    try:
        return json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError):
        return None


def gz_json_dump(path: str, obj) -> None:
    """研究格式 gzip（mtime=0 可重現）＋原子寫入。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as g:
            g.write(json.dumps(obj, ensure_ascii=False).encode('utf-8'))
    os.replace(tmp, path)


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def clone_file(src: str, dst: str) -> None:
    """APFS 複製（cp -c）；不支援時退回一般複製。目的檔先寫暫存再原子換名。"""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = f'{dst}.tmp{os.getpid()}'
    if os.path.exists(tmp):
        os.unlink(tmp)
    r = subprocess.run(['/bin/cp', '-c', src, tmp], capture_output=True)
    if r.returncode != 0:
        shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def clone_tree(src: str, dst: str) -> None:
    """整個目錄的 APFS 複本（只在 dst 不存在時；先複製到暫存目錄再換名，半途失敗不留半套）。"""
    if os.path.exists(dst):
        return
    tmp = f'{dst}.tmp{os.getpid()}'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(['/bin/cp', '-c', '-R', src, tmp], capture_output=True)
    if r.returncode != 0:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(src, tmp)
    os.replace(tmp, dst)


# ───────────────────────── 時鐘與期限 ─────────────────────────
def now_tw(override: str = None) -> datetime.datetime:
    if override:
        return datetime.datetime.strptime(override, '%Y-%m-%dT%H:%M').replace(tzinfo=TZ)
    return datetime.datetime.now(TZ)


def iso_tw(dt: datetime.datetime) -> str:
    return dt.astimezone(TZ).isoformat(timespec='seconds')


def deadline_of(target_day: str) -> datetime.datetime:
    y, m, d = (int(x) for x in target_day.split('-'))
    return datetime.datetime(y, m, d, FREEZE_HHMM[0], FREEZE_HHMM[1], tzinfo=TZ)


def log(*a) -> None:
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ───────────────────────── 休市日曆（協調器傳入）─────────────────────────
def _add_days(iso: str, n: int) -> str:
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=n)).isoformat()


class Calendar:
    """holidays（休市日）＋covered（已涵蓋年份）；與 scripts/lib/surge-shadow-daily.mjs 的 nextTradingDay 同一條規則。"""

    def __init__(self, holidays, covered, sources=()):
        self.holidays = set(holidays or ())
        self.covered = set(int(y) for y in (covered or ()))
        self.sources = list(sources)

    @classmethod
    def from_plan(cls, plan: dict) -> 'Calendar':
        c = (plan or {}).get('calendar') or {}
        if not c.get('holidays') and not c.get('covered'):
            raise Refuse('計畫檔沒有休市日曆（協調器要傳 calendar.holidays／covered）')
        return cls(c.get('holidays'), c.get('covered'), c.get('sources') or ())

    def is_trading(self, iso: str) -> bool:
        wd = datetime.date.fromisoformat(iso).weekday()
        return wd < 5 and iso not in self.holidays

    def next_trading(self, iso: str) -> str:
        d = iso
        for _ in range(31):
            d = _add_days(d, 1)
            if datetime.date.fromisoformat(d).weekday() >= 5:
                continue
            if int(d[:4]) not in self.covered:
                raise Refuse(f'休市日曆未涵蓋 {d[:4]} 年——無法判定 {iso} 的下一交易日')
            if d not in self.holidays:
                return d
        raise Refuse(f'{iso} 之後 31 天內找不到交易日（日曆異常）')

    def nth_after(self, iso: str, k: int) -> str:
        d = iso
        for _ in range(k):
            d = self.next_trading(d)
        return d

    def between(self, from_excl: str, to_incl: str) -> list:
        out, d = [], _add_days(from_excl, 1)
        while d <= to_incl:
            if self.is_trading(d):
                out.append(d)
            d = _add_days(d, 1)
        return out
