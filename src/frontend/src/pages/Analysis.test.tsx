import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisPage } from './Analysis';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getTrend: vi.fn(),
    getAnalysis: vi.fn(),
    getSiteStats: vi.fn(),
  },
}));

vi.mock('../components/Charts', () => ({
  MaterialChart: () => <div data-testid="material-chart" />,
  OceanChart: () => <div data-testid="ocean-chart" />,
  RankingChart: () => <div data-testid="ranking-chart" />,
  TrendChart: () => <div data-testid="trend-chart" />,
}));

const trend = [{ date: '2026-08-31', count: 16, density: 0.8 }];
const analysis = {
  pollutionIndex: 5.5,
  pollutionIndexPrev: 4.5,
  plasticPercent: 40,
  plasticPercentPrev: 32,
  severeCount: 2,
  severeCountPrev: 1,
  totalObjects: 100,
  materialBreakdown: { 塑料: 40, 金属: 12 },
  classRanking: [{ name: '塑料袋', count: 20 }],
};

const mockApi = vi.mocked(api);

describe('AnalysisPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getTrend.mockResolvedValue(trend);
    mockApi.getAnalysis.mockResolvedValue(analysis);
    mockApi.getSiteStats.mockResolvedValue([]);
  });

  it('renders evidence-based insight and expands governance advice', async () => {
    const user = userEvent.setup();

    render(<AnalysisPage />);

    expect(screen.getByText('正在基于检测数据生成洞察…')).toBeInTheDocument();
    expect(await screen.findByText(/最高频目标为「塑料袋」/)).toBeInTheDocument();
    expect(screen.getByText(/综合污染指数 5.5\/10 · 污染指数较上期上升/)).toBeInTheDocument();
    expect(screen.getByText(/暂无分站点数据/)).toBeInTheDocument();
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看治理建议' }));

    expect(screen.getByText(/优先安排 2 个高风险点位/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起建议' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('reloads trend data when the reporting period changes', async () => {
    const user = userEvent.setup();

    render(<AnalysisPage />);
    await screen.findByTestId('trend-chart');

    await user.selectOptions(screen.getByRole('combobox'), 'week');

    await waitFor(() => expect(mockApi.getTrend).toHaveBeenLastCalledWith('week'));
    expect(mockApi.getAnalysis).toHaveBeenCalledTimes(2);
    expect(mockApi.getSiteStats).toHaveBeenCalledTimes(2);
  });
});
