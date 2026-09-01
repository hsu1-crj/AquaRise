/**
 * 科普模式知识漂流瓶数据 —— 题目内容以 data/knowledge/ 知识库文档与
 * impactData.ts(同一口径)为据提炼, 不引入库外断言。
 * 坐标为 Ocean3D 场景坐标(±120), layer 决定漂瓶深度(水面/中层/海床)。
 */

export interface KnowledgePoi {
  id: string;
  title: string;
  zone: string;
  question: string;
  options: string[];
  answer: number;
  explain: string;
  source: string;
  x: number;
  z: number;
  layer: 'surface' | 'mid' | 'seafloor';
}

export const KNOWLEDGE_POIS: KnowledgePoi[] = [
  {
    id: 'microplastic-size', title: '微塑料的个头', zone: '近岸水面',
    question: '微塑料通常指尺寸小于多少的塑料颗粒或碎片？',
    options: ['5 厘米', '5 毫米', '0.5 毫米'],
    answer: 1,
    explain: '微塑料通常指尺寸小于 5 毫米的塑料颗粒或碎片，分为原生微塑料（工业小颗粒）与次生微塑料（大件塑料碎裂形成）。',
    source: '海洋微塑料污染知识',
    x: 34, z: -18, layer: 'surface',
  },
  {
    id: 'ghost-net', title: '幽灵渔网', zone: '海底礁区',
    question: '“幽灵渔网”指的是哪种渔网？',
    options: ['夜间作业的渔网', '会发光的渔网', '被遗弃但仍能持续捕获海洋生物的渔网'],
    answer: 2,
    explain: '幽灵渔网指被遗弃、丢失后仍会缠绕鱼类、海龟、鲸豚等动物并持续“再捕获”的渔网，它的危害不需要人为操作就能延续。',
    source: '幽灵渔网与废弃渔具专项',
    x: -42, z: 14, layer: 'seafloor',
  },
  {
    id: 'marpol-v', title: 'MARPOL 附则', zone: '航道水面',
    question: 'MARPOL 公约中与船舶垃圾（含塑料）最直接相关的是哪个附则？',
    options: ['附则 I（油类）', '附则 V（船舶垃圾）', '附则 VI（空气污染）'],
    answer: 1,
    explain: 'MARPOL 是国际海事组织防止船舶污染的核心公约；附则 V 管船舶垃圾，明确规定船舶塑料禁止排放入海。',
    source: 'MARPOL公约概要',
    x: 72, z: -58, layer: 'surface',
  },
  {
    id: 'bag-fate', title: '塑料袋的去向', zone: '中层水域',
    question: '塑料袋进入海洋后最主要的变化路径是什么？',
    options: ['几年内被彻底降解消失', '老化碎裂为微塑料，长期持留', '沉入海底变成礁石'],
    answer: 1,
    explain: '海洋中不存在统一的“降解年限”；塑料的常见路径是老化和碎裂为微塑料/纳米塑料，而不是彻底变成无害物质——降解不等于消失。',
    source: '海洋垃圾降解周期表',
    x: -78, z: -46, layer: 'mid',
  },
  {
    id: 'net-fiber', title: '渔网的材质', zone: '渔场中层',
    question: '渔网、绳索多为尼龙、聚乙烯等合成材料，老化磨损后会释放什么？',
    options: ['纤维状微塑料', '可溶解养分', '天然矿物颗粒'],
    answer: 0,
    explain: '渔网和网绳多为合成材料，老化和磨损会释放纤维状微塑料；附着在网具上的生物还可能被洋流带到新海域，改变生态位。',
    source: '幽灵渔网与废弃渔具专项',
    x: 12, z: 78, layer: 'mid',
  },
  {
    id: 'bag-jellyfish', title: '海龟的误会', zone: '暖流水面',
    question: '塑料袋在海水中漂动时形似哪种生物，导致海龟等误食？',
    options: ['水母', '海藻', '小鱼'],
    answer: 0,
    explain: '塑料袋在水中形似水母，海龟等爬行动物误食后肠道阻塞，致死率极高，被列为极高危害垃圾。',
    source: '海洋生物与生态基础知识',
    x: -28, z: -86, layer: 'surface',
  },
  {
    id: 'net-on-coral', title: '珊瑚上的渔网', zone: '珊瑚礁区',
    question: '潜水时发现渔网缠绕在珊瑚或活体生物附近，正确做法是？',
    options: ['直接用力拖拽上岸', '记录位置与生物情况，交由专业团队评估分段解缠', '剪碎就地丢弃'],
    answer: 1,
    explain: '缠绕在珊瑚或活体生物附近的渔网应先记录位置、潮汐与生物情况，由专业团队评估后分段解缠打捞，直接拖拽会造成二次损伤。',
    source: '幽灵渔网与废弃渔具专项',
    x: 88, z: 36, layer: 'seafloor',
  },
  {
    id: 'gear-prevent', title: '源头预防', zone: '养殖区水面',
    question: '减少废弃渔具入海，优先级最高的做法是什么？',
    options: ['等渔网沉底后再打捞', '渔具标记、回收与以旧换新等源头管理', '加大海上焚烧力度'],
    answer: 1,
    explain: '优先从源头减少渔具入海：渔具标记、丢失报告、回收与以旧换新、改进网具材料；港口提供回收设施是重要环节。',
    source: '幽灵渔网与废弃渔具专项',
    x: -94, z: 58, layer: 'surface',
  },
  {
    id: 'bottle-raft', title: '漂浮的"筏子"', zone: '大洋流路',
    question: '塑料瓶等漂浮垃圾长期随洋流迁移，会帮助什么扩散？',
    options: ['入侵物种（附着生物）', '海水淡化', '珊瑚产卵'],
    answer: 0,
    explain: '漂浮塑料是附着生物的“筏子”。日本海啸碎片曾携带约 300 种日本物种到达北美，外来物种随垃圾扩散会威胁本地生态。',
    source: '海洋垃圾的来源与输运',
    x: 52, z: 92, layer: 'surface',
  },
  {
    id: 'secondary-micro', title: '次生微塑料', zone: '深水层',
    question: '塑料瓶、渔网等大件塑料碎裂形成的微塑料属于哪一类？',
    options: ['原生微塑料', '次生微塑料', '不属于微塑料'],
    answer: 1,
    explain: '原生微塑料生来就是小颗粒（如工业塑料颗粒）；大件塑料在光照、波浪、磨损和老化作用下碎裂形成的是次生微塑料。',
    source: '海洋微塑料污染知识',
    x: -8, z: -72, layer: 'mid',
  },
];

export const POI_PROGRESS_KEY = 'ocean3d-poi-collected';

/** 进度按监测站隔离：每个站点独立的 localStorage key，站点之间互不影响 */
function progressKey(stationId: number | string): string {
  return `${POI_PROGRESS_KEY}:${stationId}`;
}

/** 读取指定监测站已收集进度（损坏数据按空处理） */
export function loadPoiProgress(stationId: number | string): string[] {
  try {
    const raw = window.localStorage.getItem(progressKey(stationId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function savePoiProgress(ids: string[], stationId: number | string): void {
  try {
    window.localStorage.setItem(progressKey(stationId), JSON.stringify(ids));
  } catch {
    /* 存储不可用时忽略(进度只在本次会话生效) */
  }
}
