/** A few nested components so the fiber walk produces a real
 *  component stack with `_debugSource` file:line per frame. */

function Badge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        border: "1px solid #ff6b00",
        color: "#ff6b00",
        borderRadius: "4px",
        fontSize: 12,
      }}
    >
      {label}
    </span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid #232330",
        background: "#0f0f12",
        borderRadius: 8,
        padding: 20,
        margin: "16px 0",
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}

export function App() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 48 }}>
      <h1 style={{ letterSpacing: "-0.02em" }}>InSitu — React example</h1>
      <p>
        Select any element below — the capture panel should resolve a real{" "}
        <code>file:line</code> and a component stack
        (App &lt; Card &lt; Badge).
      </p>
      <Card title="Selectable region">
        <p>This paragraph, the heading, and the badge are all targets.</p>
        <Badge label="A BADGE" />{" "}
        <button
          type="button"
          style={{
            font: "inherit",
            background: "#ff6b00",
            color: "#0b0b0d",
            border: 0,
            padding: "8px 16px",
            borderRadius: 4,
            cursor: "pointer",
          }}
          onClick={() => console.log("[example] button clicked")}
        >
          A button
        </button>
      </Card>
    </main>
  );
}
