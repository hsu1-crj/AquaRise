import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';
import { SeaAreaProvider } from '../context/SeaAreaContext';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getSummary: vi.fn(),
    getTrend: vi.fn(),
    getAnalysis: vi.fn(),
    getHistory: vi.fn(),
    getSeaAreas: vi.fn(),
  },
}));

vi.mock('../components/Charts', () => ({
  MaterialChart: () => <div data-testid="material-chart" />,
  RankingChart: () => <div data-testid="ranking-chart" />,
  TrendChart: () => <div data-testid="trend-chart" />,
}));

const summary = {
  totalTasks: 12,
  totalObjects: 86,
  seaAreas: 3,
  monthlyGrowth: 8.5,
  activeAlerts: 2,
  coverageKm2: 42,
};
const trend = [{ date: '2026-08-31', count: 8, density: 0.4 }];
const analysis = {
  pollutionIndex: 4.8,
  pollutionIndexPrev: 4.2,
  plasticPercent: 38,
  plasticPercentPrev: 35,
  severeCount: 1,
  severeCountPrev: 0,
  highRiskAreas: 1,
  highRiskAreasPrev: 0,
  totalObjects: 86,
  materialBreakdown: { 塑料: 33 },
  classRanking: [{ name: '塑料袋', count: 18 }],
};
const history = {
  items: [{
    id: 'task-17',
    createdAt: '2026-08-31 09:30',
    location: '北戴河 A-07',
    type: '图片' as const,
    objectCount: 8,
    level: '严重' as const,
    status: '已完成' as const,
  }],
  total: 1,
};

const mockApi = vi.mocked(api);

function arrangeSuccessfulLoad() {
  mockApi.getSummary.mockResolvedValue(summary);
  mockApi.getTrend.mockResolvedValue(trend);
  mockApi.getAnalysis.mockResolvedValue(analysis);
  mockApi.getHistory.mockResolvedValue(history);
  mockApi.getSeaAreas.mockResolvedValue([]);
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeSuccessfulLoad();
  });

  it('loads the overview and routes the primary action to detection', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<SeaAreaProvider><Dashboard onNavigate={onNavigate} user={{ id: 7, username: '演示用户', role: 'user' }} /></SeaAreaProvider>);


    expect(screen.getByRole('heading', { name: '正在汇聚海域数据' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '海洋污染态势总览' })).toBeInTheDocument();
    expect(screen.getByText(/演示用户/)).toBeInTheDocument();
    expect(screen.getByText('累计检测任务')).toBeInTheDocument();
    expect(screen.getByText('北戴河 A-07')).toBeInTheDocument();
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
    expect(mockApi.getHistory).toHaveBeenCalledWith(1, 4);

    await user.click(screen.getByRole('button', { name: /开始识别/ }));

    expect(onNavigate).toHaveBeenCalledWith('detection');
  });

  it('shows the load error and retries the same page contract', async () => {
    mockApi.getSummary.mockRejectedValueOnce(new Error('汇总服务离线')).mockResolvedValue(summary);
    const user = userEvent.setup();

    render(<SeaAreaProvider><Dashboard onNavigate={vi.fn()} /></SeaAreaProvider>);

    expect(await screen.findByRole('heading', { name: '数据暂时失联' })).toBeInTheDocument();
    expect(screen.getByText('汇总服务离线')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /重新加载/ }));

    expect(await screen.findByRole('heading', { name: '海洋污染态势总览' })).toBeInTheDocument();
    expect(mockApi.getSummary).toHaveBeenCalledTimes(2);
  });
});
