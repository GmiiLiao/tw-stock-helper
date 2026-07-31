import type { Metadata, Viewport } from 'next';
import '@/app/globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export const metadata: Metadata = {
  title: '台股助手 TW Stock Pro — 精準選股分析工具',
  description: '台灣股票即時行情、技術分析、智慧選股、投資組合管理。使用台灣證券交易所公開資料，提供 MACD、RSI、KD 等技術指標分析與進出場訊號。',
  keywords: '台股, 股票分析, 技術分析, 選股, 台灣股市, TWSE, 投資組合',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
