import { useChartTheme } from '../lib/useChartTheme.js';
import { formatNumber } from '../lib/format.js';

/*
 * A diverging bar for a signed quantity centred on meaningful zero -- here,
 * millimetres of rain above or below usual. Two design constraints drive it:
 *
 * - A sequential ramp cannot express a sign. The bar grows left for drier
 *   and right for wetter from a centre line, reusing the app's validated
 *   diverging pair (divNeg/divPos): the pair is already CVD-checked
 *   all-pairs in both modes, so no new colour proof is owed.
 * - Wetter takes divPos and drier divNeg by "more rain = positive direction
 *   on the anomaly axis", stated here because the mapping is a choice, not a
 *   law. The text label always carries the sign and units too, so the value
 *   never rides on hue alone.
 *
 * All styling is inline: this is the only consumer of these exact geometry
 * needs, and a stylesheet class would separate the bar from its scale logic.
 */
export function formatAnomaly(value, unit = 'mm') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  if (v === 0) return `usual (${unit})`;
  const sign = v > 0 ? '+' : '−';
  const abs = Math.abs(v);
  return `${sign}${formatNumber(abs, { decimals: abs >= 100 ? 0 : 1 })} ${unit} vs usual`;
}

export default function AnomalyBar({ value, maxAbs, unit = 'mm', height = 8 }) {
  const t = useChartTheme();
  if (value === null || value === undefined || !(maxAbs > 0)) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const frac = Math.min(Math.abs(v) / maxAbs, 1);
  const neg = v < 0;
  const label = formatAnomaly(v, unit);

  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      style={{ display: 'flex', alignItems: 'stretch', height, marginTop: 6 }}
    >
      <div style={{
        flex: 1, background: t.grid, borderRadius: '3px 0 0 3px',
        display: 'flex', justifyContent: 'flex-end', overflow: 'hidden',
      }}
      >
        {neg && <div style={{ width: `${(frac * 100).toFixed(1)}%`, background: t.divNeg }} />}
      </div>
      <div style={{ width: 2, background: t.ink3, flexShrink: 0 }} />
      <div style={{
        flex: 1, background: t.grid, borderRadius: '0 3px 3px 0', overflow: 'hidden',
      }}
      >
        {!neg && v !== 0 && <div style={{ width: `${(frac * 100).toFixed(1)}%`, background: t.divPos }} />}
      </div>
    </div>
  );
}
