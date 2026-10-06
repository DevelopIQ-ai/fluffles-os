"use client";

import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import type { ChatMessage } from "@/lib/console-api";

export interface TranscriptProps {
  messages: ChatMessage[];
  running: boolean;
}

/**
 * Codex turns render through Vercel's AI Elements message components inside the
 * console's own typography, so markdown, code, and math all come out formatted.
 */
export function Transcript({ messages, running }: TranscriptProps) {
  if (messages.length === 0 && !running) {
    return (
      <div className="transcript">
        <div className="transcript-empty">
          <p className="empty-title">No messages yet</p>
          <p className="empty-text">Send a message and Fluffles answers here with Codex, in the same durable conversation Slack, email, and phone use.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript">
      {messages.map((message) => {
        const role = message.direction === "inbound" ? "user" : "assistant";
        return (
          <div className={`turn ${role}`} key={message.id}>
            <span className="turn-role">{role === "user" ? "You" : "Fluffles"}</span>
            <Message from={role}>
              <MessageContent className="turn-body">
                <MessageResponse>{message.text}</MessageResponse>
              </MessageContent>
            </Message>
          </div>
        );
      })}
      {running && (
        <div className="turn assistant turn-pending">
          <span className="turn-role">Fluffles</span>
          <div className="turn-body">thinking with Codex...</div>
        </div>
      )}
    </div>
  );
}
