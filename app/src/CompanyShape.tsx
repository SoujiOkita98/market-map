/**
 * CompanyShape — the custom tldraw shape for a company on the market map.
 *
 * It carries both VISUAL properties (size, color, logo) and structured
 * METADATA (revenue, role, regions, sources, ...). The metadata is stored as an
 * arbitrary JSON value so the agent can attach whatever facts it researches
 * without us changing the schema each time.
 */
import {
  HTMLContainer,
  type Geometry2d,
  Rectangle2d,
  type RecordProps,
  ShapeUtil,
  T,
  type TLShape,
  resizeBox,
  type TLResizeInfo,
} from 'tldraw';

export type CompanySource = { label: string; url: string };

type CompanyShapeProps = {
  name: string;
  subtitle: string;
  w: number;
  h: number;
  color: string;
  logoUrl: string | null;
  metadata: unknown; // arbitrary JSON-serialisable facts
  sources: CompanySource[];
};

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    company: CompanyShapeProps;
  }
}

export type CompanyShape = TLShape<'company'>;

// A small, friendly palette. Keys are what the agent passes as --color.
const PALETTE: Record<string, { bg: string; border: string; text: string }> = {
  blue: { bg: '#eef4ff', border: '#3b82f6', text: '#1e3a8a' },
  orange: { bg: '#fff4e6', border: '#f97316', text: '#9a3412' },
  violet: { bg: '#f3eefe', border: '#8b5cf6', text: '#5b21b6' },
  green: { bg: '#eafaf0', border: '#22c55e', text: '#166534' },
  red: { bg: '#fdeeee', border: '#ef4444', text: '#991b1b' },
  grey: { bg: '#f3f4f6', border: '#9ca3af', text: '#374151' },
  yellow: { bg: '#fef9e7', border: '#eab308', text: '#854d0e' },
};
const swatch = (c: string) => PALETTE[c] ?? PALETTE.blue;

export class CompanyShapeUtil extends ShapeUtil<CompanyShape> {
  static override type = 'company' as const;

  static override props: RecordProps<CompanyShape> = {
    name: T.string,
    subtitle: T.string,
    w: T.number,
    h: T.number,
    color: T.string,
    logoUrl: T.string.nullable(),
    metadata: T.jsonValue,
    sources: T.arrayOf(T.object({ label: T.string, url: T.string })),
  };

  override getDefaultProps(): CompanyShape['props'] {
    return { name: 'Company', subtitle: '', w: 240, h: 140, color: 'blue', logoUrl: null, metadata: {}, sources: [] };
  }

  override canResize() {
    return true;
  }

  override onResize(shape: CompanyShape, info: TLResizeInfo<CompanyShape>) {
    return resizeBox(shape, info);
  }

  override getGeometry(shape: CompanyShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override component(shape: CompanyShape) {
    const { name, subtitle, w, h, color, logoUrl, metadata, sources } = shape.props;
    const c = swatch(color);
    const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    const metaEntries = Object.entries(meta).slice(0, 4);

    return (
      <HTMLContainer
        style={{
          width: w,
          height: h,
          pointerEvents: 'all',
          background: c.bg,
          border: `2px solid ${c.border}`,
          borderRadius: 12,
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          padding: 12,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          overflow: 'hidden',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: c.text,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: 4, flex: '0 0 auto' }}
              draggable={false}
            />
          ) : null}
          <div style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.1 }}>{name}</div>
        </div>
        {subtitle ? <div style={{ fontSize: 11, opacity: 0.75 }}>{subtitle}</div> : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, marginTop: 2, overflow: 'hidden' }}>
          {metaEntries.map(([k, v]) => (
            <div key={k} style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
              <span style={{ opacity: 0.6 }}>{k}: </span>
              <span>{String(v)}</span>
            </div>
          ))}
        </div>
        {sources && sources.length > 0 ? (
          <div style={{ marginTop: 'auto', fontSize: 10, opacity: 0.6 }}>
            {sources.length} source{sources.length > 1 ? 's' : ''}
          </div>
        ) : null}
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: CompanyShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
