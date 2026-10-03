"""A31-D 尾盤五檔（x_bd_*）初探：覆蓋率、漲停股排隊量與隔日漲停的關係（唯讀，不寫 Firestore）。"""
import numpy as np, pandas as pd

SP = '.surge-cache'
BD0 = '2026-07-20'


def load_window():
    z = np.load(f'{SP}/dataset_lu1.npz', allow_pickle=True)
    dates = np.array(z['dates']); s = z['m_s']
    keep = dates[s] >= BD0
    cols = [k for k in z.files if k.startswith('m_') or k.startswith('x_')]
    df = pd.DataFrame({k: z[k][keep] for k in cols})
    df['date'] = dates[df['m_s'].values]
    df['code'] = np.array(z['codes'])[df['m_j'].values]
    return df, dates


if __name__ == '__main__':
    df, dates = load_window()
    print('rows', len(df), 'days', df.date.nunique())
    g = df.groupby('date').agg(n=('m_y', 'size'), y=('m_y', 'sum'), lu=('m_lu_s', 'sum'),
                               has=('x_bd_has', lambda v: np.nansum(v == 1)), hasnan=('x_bd_has', lambda v: np.isnan(v).sum()),
                               lu_has=('x_bd_has', 'size'))
    lu = df[df.m_lu_s == 1]
    g['lu_has'] = lu.groupby('date')['x_bd_has'].apply(lambda v: np.nansum(v == 1))
    g['lu_y'] = lu.groupby('date')['m_y'].sum()
    pd.set_option('display.width', 200)
    print(g.to_string())
    print('LU_s rows', len(lu), 'with book', int((lu.x_bd_has == 1).sum()))
    print('cont rate all LU_s', lu.m_y.mean(), 'buy', lu.m_buy_lu.mean())
    lub = lu[lu.x_bd_has == 1]
    print('cont rate LU_s with book', lub.m_y.mean(), 'buy', lub.m_buy_lu.mean(), 'locked1', lub.m_locked1.mean())
    lun = lu[lu.x_bd_has != 1]
    print('cont rate LU_s w/o book', lun.m_y.mean())
    print(lub[['x_bd_bidlim', 'x_bd_q_v', 'x_bd_imb', 'x_bd_bid', 'x_bd_ask', 'x_oneword_s', 'x_lu_streak']].describe().T)
    print('bidlim==0 share', (lub.x_bd_bidlim == 0).mean())
