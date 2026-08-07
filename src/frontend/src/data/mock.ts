import type { DetectionRecord, DetectionResult, Report, Summary, TrendPoint } from '../types';

export const mockSummary: Summary = {
  totalTasks: 12846,
  totalObjects: 487392,
  seaAreas: 28,
  monthlyGrowth: 18.6,
  activeAlerts: 3,
  coverageKm2: 126.8,
};

export const mockTrend: TrendPoint[] = [
  { date: '07-07', count: 126, density: 2.1 },
  { date: '07-10', count: 164, density: 2.8 },
  { date: '07-13', count: 138, density: 2.4 },
  { date: '07-16', count: 207, density: 3.5 },
  { date: '07-19', count: 189, density: 3.1 },
  { date: '07-22', count: 242, density: 4.2 },
  { date: '07-25', count: 218, density: 3.8 },
  { date: '07-28', count: 296, density: 4.9 },
  { date: '07-31', count: 268, density: 4.4 },
  { date: '08-03', count: 321, density: 5.3 },
  { date: '08-05', count: 284, density: 4.7 },
];

export const mockRecords: DetectionRecord[] = [
  { id: 'DET-260805-091', createdAt: '2026-08-05 14:32', location: '渤海湾 A-07', type: '图片', objectCount: 46, level: '差', status: '已完成' },
  { id: 'DET-260805-088', createdAt: '2026-08-05 13:18', location: '北戴河近岸 B-12', type: '视频', objectCount: 128, level: '中', status: '已完成' },
  { id: 'DET-260805-073', createdAt: '2026-08-05 10:05', location: '秦皇岛港 C-03', type: '图片', objectCount: 21, level: '良', status: '已完成' },
  { id: 'DET-260804-164', createdAt: '2026-08-04 17:46', location: '渤海湾 A-02', type: '视频', objectCount: 294, level: '严重', status: '已完成' },
  { id: 'DET-260804-151', createdAt: '2026-08-04 15:11', location: '昌黎海域 D-09', type: '图片', objectCount: 9, level: '优', status: '已完成' },
  { id: 'DET-260804-139', createdAt: '2026-08-04 12:24', location: '北戴河近岸 B-08', type: '视频', objectCount: 76, level: '中', status: '已完成' },
];

export const mockReports: Report[] = [
  { id: 'RPT-20260805-04', title: '渤海湾 A-07 海域污染质量报告', area: '渤海湾 A-07', createdAt: '2026-08-05 14:36', level: '差', score: 42, objectCount: 46, status: '已生成', summary: '该点位塑料类垃圾密度显著高于近30日均值，主要为塑料瓶、包装袋与废弃绳网。建议72小时内安排ROV复核并开展定点打捞。' },
  { id: 'RPT-20260805-02', title: '北戴河近岸周度监测报告', area: '北戴河近岸', createdAt: '2026-08-05 11:20', level: '中', score: 67, objectCount: 224, status: '已生成', summary: '本周垃圾密度环比下降8.4%，金属罐与玻璃类占比稳定，幽灵渔网风险仍需持续监测。' },
  { id: 'RPT-20260804-09', title: '秦皇岛港 C-03 专项评估报告', area: '秦皇岛港 C-03', createdAt: '2026-08-04 18:08', level: '良', score: 82, objectCount: 21, status: '已生成', summary: '监测区域整体质量良好，零散生活垃圾集中于码头东南侧，可合并至常规保洁任务处理。' },
];

export function createMockDetection(width: number, height: number): DetectionResult {
  return {
    taskId: `DET-${Date.now().toString().slice(-8)}`,
    sourceWidth: width,
    sourceHeight: height,
    objects: [
      { id: 'box-1', label: 'trash_bottle', labelZh: '塑料瓶', confidence: 0.94, bbox: [width * 0.12, height * 0.2, width * 0.22, height * 0.34], material: '塑料' },
      { id: 'box-2', label: 'trash_net', labelZh: '废弃渔网', confidence: 0.87, bbox: [width * 0.53, height * 0.14, width * 0.32, height * 0.48], material: '渔具' },
      { id: 'box-3', label: 'trash_can', labelZh: '金属罐', confidence: 0.81, bbox: [width * 0.38, height * 0.63, width * 0.16, height * 0.21], material: '金属' },
    ],
    pollutionLevel: '中',
    density: 3.7,
    qualityScore: 68,
    processedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}
