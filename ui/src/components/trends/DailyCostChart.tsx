import { useEffect, useRef, useState } from 'react';
import { usd } from '../../format';
import type { TrendDay } from './useTrends';

const HEIGHT = 220;
const PAD = { l: 68, r: 24, t: 18, b: 28 };

export const trendDayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export function DailyCostChart({ days }: { days: TrendDay[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(Math.max(260, Math.round(entry.contentRect.width)));
      }
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const maxCost = Math.max(0.01, ...days.filter((day) => day.costKnown).map((day) => day.costUsd));
  const barWidth = (width - PAD.l - PAD.r) / Math.max(1, days.length);
  const labelStep = Math.max(1, Math.ceil(60 / barWidth));
  const chartHeight = HEIGHT - PAD.t - PAD.b;

  return (
    <div ref={container} className="trends-chart">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="trends-svg"
        role="img"
        aria-label="Known cost per day. Exact values are available under View daily figures."
      >
        {[0, 0.5, 1].map((fraction) => {
          const y = PAD.t + chartHeight * (1 - fraction);
          return (
            <g key={fraction}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y} y2={y} className="trends-gridline" />
              <text x={PAD.l - 8} y={y + 4} textAnchor="end" className="trends-axis">
                {usd(maxCost * fraction)}
              </text>
            </g>
          );
        })}
        {days.map((day, index) => {
          const height = day.costKnown ? (day.costUsd / maxCost) * chartHeight : 0;
          const x = PAD.l + index * barWidth;
          const showLabel =
            (index % labelStep === 0 && index < days.length - labelStep / 2) ||
            index === days.length - 1;
          return (
            <g key={day.day}>
              <rect
                x={x + 2}
                y={PAD.t + chartHeight - height}
                width={Math.max(1, barWidth - 4)}
                height={Math.max(0, height)}
                rx={3}
                className="trends-bar"
              >
                <title>{`${day.day}: ${day.costKnown ? usd(day.costUsd) : 'cost unavailable'} · ${day.unknownUsageCount} unknown · ${day.prompts} prompts · ${day.sessions} sessions`}</title>
              </rect>
              {showLabel && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  className="trends-axis"
                >
                  {trendDayLabel(day.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
