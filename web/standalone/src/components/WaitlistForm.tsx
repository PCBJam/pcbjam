import * as React from "react";
import { Loader2 } from "lucide-react";
import { LANDING_URL, WAITLIST_URL } from "@/lib/config";
import { Button, Input } from "@pcbjam/ui";

/**
 * Email capture for the standalone home page — a React port of the landing
 * site's WaitlistForm.astro. The demo deploy has no backend, so it cross-posts
 * the same JSON contract to the landing site's serverless endpoint (WAITLIST_URL,
 * which sends CORS for this origin). Honeypot `company_url` mirrors the site form.
 */
export function WaitlistForm({ source = "standalone" }: { source?: string }) {
  const [email, setEmail] = React.useState("");
  const [honeypot, setHoneypot] = React.useState("");
  const [state, setState] = React.useState<"idle" | "busy" | "ok" | "error">(
    "idle",
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === "busy") return;
    setState("busy");
    try {
      const res = await fetch(WAITLIST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, source, company_url: honeypot }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setState(res.ok && data.ok ? "ok" : "error");
    } catch {
      setState("error");
    }
  };

  return (
    <section className="mb-10 rounded-lg border bg-card p-5">
      <h2 className="mb-1 text-lg font-medium">Get early-access invites</h2>
      {state === "ok" ? (
        <p className="mt-2 text-sm">
          <strong>You're on the list. 🎉</strong>{" "}
          <span className="text-muted-foreground">
            We'll be in touch with product updates and your early-access invite.
          </span>
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            Join the waitlist for product updates and your invite.
          </p>
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              disabled={state === "busy"}
              onChange={(e) => setEmail(e.target.value)}
              className="sm:max-w-xs"
            />
            {/* Honeypot — humans never see/fill this. */}
            <input
              type="text"
              name="company_url"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              className="hidden"
            />
            <Button type="submit" disabled={state === "busy"}>
              {state === "busy" && <Loader2 className="animate-spin" size={15} />}
              Join the waitlist
            </Button>
          </form>
          {state === "error" && (
            <p className="mt-2 text-sm text-destructive">
              Please enter a valid email address and try again.
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            <a
              href={`${LANDING_URL}/privacy`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              Privacy policy
            </a>
          </p>
        </>
      )}
    </section>
  );
}
