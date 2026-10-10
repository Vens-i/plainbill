export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <main className="page">
      <h1 className="greeting">{title}</h1>
      <div className="placeholder">
        <p>
          <b>{title}</b> arrives in {phase}.
        </p>
        <p>For now, everything happens on the Dashboard.</p>
      </div>
    </main>
  );
}
