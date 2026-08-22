import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SeaArea } from '../types';
import { api } from '../services/api';

/** 侧边栏全局海域选择的 localStorage key（跨页刷新保留所选海域） */
export const SEA_AREA_KEY = 'aquarise-sea-area';

interface SeaAreaContextValue {
  /** 当前海域 id；'' 表示「全部海域」 */
  seaAreaId: number | '';
  /** 当前海域名（用于 pill 文案显示） */
  seaAreaName: string;
  seaAreas: SeaArea[];
  setSeaAreaId: (id: number | '') => void;
}

const SeaAreaContext = createContext<SeaAreaContextValue | null>(null);

export function SeaAreaProvider({ children }: { children: ReactNode }) {
  const [seaAreas, setSeaAreas] = useState<SeaArea[]>([]);
  const [seaAreaId, setSeaAreaIdState] = useState<number | ''>(() => {
    const raw = window.localStorage.getItem(SEA_AREA_KEY);
    if (raw === null) return '';
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? (parsed as number) : '';
  });

  // 载入海域列表（mock 返回静态 3 海域，live 调后端）；
  // localStorage 里残留的失效海域 id（历史数据变更后）自动回退"全部海域"
  useEffect(() => {
    let mounted = true;
    api.getSeaAreas().then((list) => {
      if (!mounted) return;
      setSeaAreas(list);
      setSeaAreaIdState((current) => (current !== '' && list.some((a) => a.id === current) ? current : ''));
    }).catch(() => { /* 海域列表失败不阻塞 */ });
    return () => { mounted = false; };
  }, []);

  const setSeaAreaId = (id: number | '') => {
    setSeaAreaIdState(id);
    if (id === '') {
      window.localStorage.removeItem(SEA_AREA_KEY);
    } else {
      window.localStorage.setItem(SEA_AREA_KEY, String(id));
    }
  };

  const value = useMemo<SeaAreaContextValue>(() => {
    const current = seaAreas.find((a) => a.id === seaAreaId);
    return {
      seaAreaId,
      seaAreaName: current?.name ?? '全部海域',
      seaAreas,
      setSeaAreaId,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seaAreaId, seaAreas]);

  return <SeaAreaContext.Provider value={value}>{children}</SeaAreaContext.Provider>;
}

export function useSeaArea(): SeaAreaContextValue {
  const ctx = useContext(SeaAreaContext);
  if (!ctx) throw new Error('useSeaArea 必须在 <SeaAreaProvider> 内使用');
  return ctx;
}
