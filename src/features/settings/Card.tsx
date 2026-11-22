/** The building blocks every settings area is made of: a titled card and a labelled row in it. */
export function Card({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-card p-5 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1"><h2 className="shrink-0 whitespace-nowrap text-base font-extrabold tracking-tight">{title}</h2>{hint && <span className="min-w-0 flex-1 basis-60 text-xs font-semibold text-muted-foreground">{hint}</span>}{action && <span className="ml-auto shrink-0">{action}</span>}</div>
      {children}
    </section>
  );
}
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border py-3 last:border-0"><b className="shrink-0 text-sm">{label}</b>{children}</div>;
}
