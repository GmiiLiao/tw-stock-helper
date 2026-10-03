"""build_v2.segments 的合成資料測試（區段、起點、冷卻、進行中區段、>35% 嚴格大於）。"""
import numpy as np
import build_v2 as V

T = 40
# ── T1：連板 ──
LU = np.zeros((T, 1), bool); LU[[10, 11, 12], 0] = True; LU[20, 0] = True; LU[[25, 26], 0] = True
Ca = np.full((T, 1), 100.0)
Caprev = np.vstack([np.full((1, 1), np.nan), Ca[:-1]])
EV = dict(LU=LU, up=Ca > Caprev, Caprev=Caprev)
S = V.segments(EV, Ca)
st1 = set(np.nonzero(S['start1'][:, 0])[0]); seg1 = set(np.nonzero(S['seg1'][:, 0])[0])
assert st1 == {10, 25}, st1                 # 單日漲停(20)不算連板
assert seg1 == {10, 11, 12, 25, 26}, seg1
c1 = S['cool1'][:, 0]
assert not c1[10] and c1[11] and c1[13] and c1[22] and not c1[23] and not c1[9]          # 區段後 10 日內冷卻、之前不算
assert c1[20] and not c1[24]                                                         # s=20 仍在 10~12 的冷卻內；24 已出冷卻
assert c1[27] and c1[35] and not c1[37]                                              # 25、26 後的冷卻

# ── T2：5 日連漲 >35% ──
Ca = np.full((T, 1), 100.0)
for k, d in enumerate(range(10, 15)): Ca[d:, 0] = 100.0 * 1.08 ** (k + 1)            # 10..14 連 5 日 +8%（累計 1.469）
Caprev = np.vstack([np.full((1, 1), np.nan), Ca[:-1]])
EV = dict(LU=np.zeros((T, 1), bool), up=Ca > Caprev, Caprev=Caprev)
S = V.segments(EV, Ca)
assert set(np.nonzero(S['W2'][:, 0])[0]) == {10}, np.nonzero(S['W2'][:, 0])          # 只有 t=10 的視窗成立（11..15 的第 15 日持平）
assert set(np.nonzero(S['seg2'][:, 0])[0]) == set(range(10, 15))
assert set(np.nonzero(S['start2'][:, 0])[0]) == {10}
c2 = S['cool2'][:, 0]
assert not c2[13] and c2[14] and c2[24] and not c2[25]                              # 視窗起點 v∈[s−14, s−4]：s∈[14,24]；進行中(13)不用
assert not c2[9]

# 累計未超過 35%：5 日 +6%（1.338）不成立；剛好邊界不納入（嚴格大於）
Ca = np.full((T, 1), 100.0)
for k, d in enumerate(range(10, 15)): Ca[d:, 0] = 100.0 * 1.06 ** (k + 1)
Caprev = np.vstack([np.full((1, 1), np.nan), Ca[:-1]])
S = V.segments(dict(LU=np.zeros((T, 1), bool), up=Ca > Caprev, Caprev=Caprev), Ca)
assert not S['W2'].any()
# 超過 35% 但中間一天沒漲 → 不成立（要求「連漲」）
Ca = np.full((T, 1), 100.0)
for k, d in enumerate([10, 11, 13, 14, 15]): Ca[d:, 0] = 100.0 * 1.10 ** (k + 1)       # 12 日持平
Caprev = np.vstack([np.full((1, 1), np.nan), Ca[:-1]])
S = V.segments(dict(LU=np.zeros((T, 1), bool), up=Ca > Caprev, Caprev=Caprev), Ca)
assert not S['W2'].any()
print('✓ v2 區段邏輯測試全部通過')
