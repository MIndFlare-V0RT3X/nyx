// SPDX-License-Identifier: AGPL-3.0-or-later
// One assistant/user message: text paragraphs, collapsible reasoning,
// tool_use and tool_result blocks rendered as cards.

import type { ContentBlock, ToolOutput } from "../types.js";
import type { ToolCardView } from "../events.js";

function describeOutput(output: ToolOutput): string {
  switch (output.kind) {
    case "text":
      return output.text;
    case "json":
      return JSON.stringify(output.json, null, 2);
    case "file":
      return `[file ${output.path} · ${output.bytes} bytes · ${output.mime}]`;
    case "artifact":
      return `[artifact ${output.artifact_id} · ${output.path} · ${output.bytes} bytes]`;
  }
}

function Block(props: {
  block: ContentBlock;
  toolCards: Record<string, ToolCardView>;
}): React.ReactElement | null {
  const { block } = props;
  switch (block.type) {
    case "text":
      return <p className="msg-text">{block.text}</p>;
    case "reasoning":
      return (
        <details className="reasoning">
          <summary>reasoning</summary>
          <pre>{block.text}</pre>
        </details>
      );
    case "image":
      return <p className="msg-meta">[image {block.mime}]</p>;
    case "tool_use": {
      const card = props.toolCards[block.call_id];
      return (
        <div className={`toolcard ${card?.status ?? "pending"}`}>
          <div className="toolcard-head">
            <span className="tool-name">⚙ {block.name}</span>
            <span className={`status status-${card?.status ?? "pending"}`}>
              {card?.status ?? "pending"}
            </span>
          </div>
          <pre className="tool-input">{JSON.stringify(block.input, null, 2)}</pre>
          {card?.output !== undefined && (
            <pre className="tool-output">{describeOutput(card.output)}</pre>
          )}
          {card?.error !== undefined && <pre className="tool-error">{card.error.message}</pre>}
        </div>
      );
    }
    case "tool_result":
      return <pre className="tool-result">{describeOutput(block.output)}</pre>;
    default:
      return null;
  }
}

export function MessageBubble(props: {
  role: "user" | "assistant";
  content: ContentBlock[];
  toolCards: Record<string, ToolCardView>;
}): React.ReactElement {
  return (
    <div className={`bubble ${props.role}`}>
      {props.content.map((block, i) => (
        <Block key={i} block={block} toolCards={props.toolCards} />
      ))}
    </div>
  );
}
