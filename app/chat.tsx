"use client";

import { useEveAgent } from "eve/react";
import { useState, type FormEvent } from "react";

export function Chat() {
  const agent = useEveAgent({
    // The proxy is mounted at /api/eve/v1; useEveAgent appends /eve/v1.
    host: "/api",
  });
  const [input, setInput] = useState("");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (text && !isBusy) {
      agent.send(text);
      setInput("");
    }
  }

  return (
    <div className="chat-container">
      <header>
        <h1>Eve Agent</h1>
        <span className={`status ${agent.status}`}>{agent.status}</span>
      </header>

      {agent.error && (
        <p className="error-message" role="alert">
          {agent.error.message}
        </p>
      )}

      <main className="messages">
        {agent.data.messages.length === 0 && (
          <p className="placeholder">Send a message to start chatting.</p>
        )}
        {agent.data.messages.map((msg) => (
          <article key={msg.id} className={`message ${msg.role}`}>
            <strong>{msg.role}</strong>
            {msg.parts.map((part, i) =>
              part.type === "text" ? <p key={i}>{part.text}</p> : null,
            )}
          </article>
        ))}
      </main>

      <form onSubmit={onSubmit} className="composer">
        <input
          name="message"
          placeholder="Type your message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isBusy}
        />
        <button type="submit" disabled={isBusy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}