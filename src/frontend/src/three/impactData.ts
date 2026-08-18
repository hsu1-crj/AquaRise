/**
 * 科普模式垃圾影响链数据（口径与项目知识库 data/knowledge 一致）。
 * 降解年限为量级参考——温度/光照/受力差异极大，知识库明确"不建议当作精确答案"，
 * 界面统一标注"量级估计"。影响链为知识库中该类垃圾的主要危害路径。
 */

export interface GarbageImpact {
  key: string;
  name: string;
  color: string;
  /** 降解量级（年）与展示文案 */
  degradeYears: number;
  degradeText: string;
  /** 影响链：按因果顺序展示 */
  chain: string[];
  /** 一条硬数据（来源：项目知识库） */
  stat: string;
}

export const GARBAGE_IMPACTS: GarbageImpact[] = [
  {
    key: 'bag', name: '塑料袋', color: '#ff6f91',
    degradeYears: 20, degradeText: '20 年+（量级估计）',
    chain: ['在海水中形似水母', '海龟等误食导致肠道阻塞', '紫外老化碎裂为微塑料', '微塑料进入食物链返回人类餐桌'],
    stat: '知识库（海洋生物与生态）：塑料袋对海龟等爬行动物误食致死率极高，被列为极高危害垃圾',
  },
  {
    key: 'net', name: '渔网', color: '#7068ff',
    degradeYears: 600, degradeText: '约 600 年（量级估计）',
    chain: ['沉底成为"幽灵渔网"持续捕捞', '缠绕珊瑚礁与底栖生物', '缠住鲸豚使其无法浮出呼吸', '碎裂后仍持续危害数百年'],
    stat: '知识库（幽灵渔网专项）：全球每年约 30 万头鲸豚因渔具缠绕死亡',
  },
  {
    key: 'bottle', name: '塑料瓶', color: '#20d7ff',
    degradeYears: 450, degradeText: '约 450 年（量级估计）',
    chain: ['长期漂浮随洋流迁移数千公里', '作为附着载体帮助入侵物种扩散', '逐步碎裂为微塑料', '吸附污染物后被滤食生物摄入'],
    stat: '知识库（海洋垃圾的来源与输运）：日本海啸碎片曾携带约 300 种日本物种到达北美',
  },
  {
    key: 'can', name: '金属罐', color: '#ffbd66',
    degradeYears: 200, degradeText: '约 200 年（量级估计）',
    chain: ['金属离子缓慢溶出污染水体', '尖锐边缘割伤海洋生物', '沉底掩埋破坏底栖栖息地'],
    stat: '知识库（海洋污染类型与生态影响）：金属类垃圾的重金属溶出是近岸底栖环境的长期污染源',
  },
  {
    key: 'wrapper', name: '零食包装', color: '#54f1a9',
    degradeYears: 100, degradeText: '约 100 年（量级估计）',
    chain: ['碎片色彩鲜艳吸引海鸟啄食', '胃内堆积产生"饱腹假象"导致饥饿', '碎裂为微塑料污染整个水层'],
    stat: '知识库（海洋垃圾与人类健康）：海鸟胃中塑料检出比例随近岸包装垃圾增多持续上升',
  },
  {
    key: 'rope', name: '绳索', color: '#c792ea',
    degradeYears: 500, degradeText: '约 500 年（量级估计）',
    chain: ['缠绕珊瑚礁阻断光合作用', '缠住潜水动物鳍肢', '随洋流形成大面积缠绕带'],
    stat: '知识库（幽灵渔网专项）：废弃绳索与渔网同为主要缠绕源，清理成本远高于源头拦截',
  },
];

export function impactByKey(key: string): GarbageImpact | undefined {
  return GARBAGE_IMPACTS.find((g) => g.key === key);
}
