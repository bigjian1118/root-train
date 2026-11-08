import { Fragment, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

const BOLD_PATTERN = /(\*\*[^*]+\*\*)/g;
const LIST_PATTERN = /^\s*(?:[-*•]|\d+[.、])\s+(.*)$/;
const HEADING_PATTERN = /^\s*(#{1,6})\s+(.*)$/;

function renderInline(text: string): ReactNode[] {
  return text.split(BOLD_PATTERN).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

interface MarkdownTextProps {
  content?: string;
  className?: string;
}

/** AI 正文轻量渲染：只处理分段、加粗、标题、列表，⚠️ 等符号原样保留。 */
export function MarkdownText({ content, className }: MarkdownTextProps) {
  if (!content || !content.trim()) {
    return null;
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    const items = listItems;
    listItems = [];
    blocks.push(
      <ul key={`list-${blocks.length}`} className="list-disc space-y-1 pl-5">
        {items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushList();
      return;
    }

    const listMatch = LIST_PATTERN.exec(line);
    if (listMatch) {
      listItems.push(listMatch[1]);
      return;
    }
    flushList();

    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      blocks.push(
        level <= 2 ? (
          <h3 key={index} className="pt-2 text-base font-semibold">
            {renderInline(headingText)}
          </h3>
        ) : (
          <h4 key={index} className="pt-1 text-sm font-semibold">
            {renderInline(headingText)}
          </h4>
        ),
      );
      return;
    }

    blocks.push(
      <p key={index} className="whitespace-pre-wrap">
        {renderInline(line)}
      </p>,
    );
  });
  flushList();

  return <div className={cn('space-y-3 text-sm leading-7 text-foreground/90', className)}>{blocks}</div>;
}
