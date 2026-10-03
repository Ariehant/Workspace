import { FILE_ICON_PREFIX } from '@workspace/core';
import { FileText } from 'lucide-react';

export interface PageIconProps {
  /** Emoji, `file:<id>` for an uploaded image, or `null` for the default icon. */
  icon: string | null;
  /** Rendered size in px. */
  size: number;
  fileUrl(id: string): string;
  className?: string;
}

/** A page's icon wherever pages are listed: sidebar, links, mentions, pickers. */
export function PageIcon({ icon, size, fileUrl, className }: PageIconProps) {
  if (icon?.startsWith(FILE_ICON_PREFIX)) {
    return (
      <img
        src={fileUrl(icon.slice(FILE_ICON_PREFIX.length))}
        alt=""
        draggable={false}
        className={className}
        style={{
          width: size,
          height: size,
          objectFit: 'cover',
          borderRadius: Math.max(2, size / 8),
        }}
      />
    );
  }
  if (icon) {
    return (
      <span className={className} style={{ fontSize: size * 0.9, lineHeight: 1 }}>
        {icon}
      </span>
    );
  }
  return <FileText size={size} strokeWidth={1.6} className={className} />;
}
