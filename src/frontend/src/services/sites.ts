import type { SiteStat } from '../types';

/** 每片海域只保留一个代表监测站（北戴河/秦皇岛/渤海湾各一处）。
 *  「三站」口径的全局唯一实现：海洋 3D 态势页站点列表与智能识别页站点选择共用，
 *  避免各页面各自去重导致站点不一致。 */
export function oneSitePerSeaArea(siteList: SiteStat[]): SiteStat[] {
  const seen = new Set<number>();
  return siteList.filter((s) => {
    if (s.seaAreaId == null) return true;
    if (seen.has(s.seaAreaId)) return false;
    seen.add(s.seaAreaId);
    return true;
  });
}
