'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';

// G3-22（2026-10-04）：交易／記錄視窗的關閉防呆，三個 modal 共用。
// - Esc 關閉（IME 組字中的 Esc 不算——手機／注音取消候選字時不能把整張表關掉）。
// - 點遮罩：表單有輸入時先確認，避免手滑把填到一半的交易丟掉；沒輸入就直接關。
// - 只有「按下與放開都在遮罩上」才算點遮罩：在輸入框裡拖曳選字、放開時滑到遮罩上，不應關閉。
// 「取消」按鈕是明確意圖，呼叫端直接用 onClose，不經確認。
const CONFIRM_DISCARD = '有尚未儲存的輸入，確定要關閉並放棄嗎？';

export function useModalDismiss(onClose: () => void, isDirty: () => boolean) {
  const latest = useRef({ onClose, isDirty });
  useEffect(() => { latest.current = { onClose, isDirty }; }, [onClose, isDirty]);
  const downOnOverlay = useRef(false);

  const requestClose = useCallback(() => {
    const { onClose: close, isDirty: dirty } = latest.current;
    if (dirty() && !window.confirm(CONFIRM_DISCARD)) return;
    close();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const overlayProps = {
    onMouseDown: (e: MouseEvent<HTMLDivElement>) => { downOnOverlay.current = e.target === e.currentTarget; },
    onClick: (e: MouseEvent<HTMLDivElement>) => {
      const fromOverlay = downOnOverlay.current && e.target === e.currentTarget;
      downOnOverlay.current = false;
      if (fromOverlay) requestClose();
    },
  };

  return { requestClose, overlayProps };
}
