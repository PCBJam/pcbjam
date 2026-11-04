import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@pcbjam/ui";
import type { SaveModalRow } from "@/libs/part-copy";
import { usePendingPartCopySave } from "@/libs/part-copy-prompt";

/**
 * libs 0031: the save modal. KiCad's Save / Save All reached parts of a
 * library the user can't write; every part the save writes is listed with
 * where it goes, read-only ones as copies in the project's library (the team's
 * default one outside a project).
 * Cancel writes nothing and keeps the edits.
 */
export function PartCopySaveDialog() {
  const pending = usePendingPartCopySave();
  if (!pending) return null;
  const { request, answer } = pending;
  const blocked = request.rows.some((r) => r.readOnly && !r.target);
  const parts = request.rows.length === 1 ? `1 ${request.kind}` : `${request.rows.length} ${request.kind}s`;

  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent data-testid="part-copy-save-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Save {parts}</DialogTitle>
          <DialogDescription>
            {blocked
              ? "Some parts can't be saved: their library is read-only for you and they can't be copied."
              : "Parts of a read-only library are saved as copies."}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto text-sm" data-testid="part-copy-save-rows">
          {request.rows.map((row) => (
            <li key={`${row.lib}:${row.name}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono">
                {row.lib}:{row.name}
              </span>
              <span className="text-muted-foreground">→</span>
              <RowDestination row={row} />
            </li>
          ))}
        </ul>
        {!blocked && (
          <p className="text-sm text-muted-foreground">
            {request.kind === "symbol"
              ? "Placed symbols keep using the originals. Switch them with Change Symbols when you're ready."
              : "Placed footprints keep using the originals. Switch them in the schematic's Footprint field when you're ready."}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)} data-testid="part-copy-save-cancel">
            Cancel
          </Button>
          <Button onClick={() => answer(true)} disabled={blocked} data-testid="part-copy-save-confirm">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowDestination({ row }: { row: SaveModalRow }) {
  if (!row.readOnly) return <span>saved in place (overwrites)</span>;
  if (!row.target) return <span className="text-destructive">can't be copied: {row.error ?? "unknown error"}</span>;
  const { target } = row;
  return (
    <span>
      {target.name === row.name ? "copy" : <>copy <span className="font-mono">{target.name}</span></>} in "{target.lib}" library
      <span className="text-muted-foreground">
        {target.earlier
          ? " (replaces your earlier copy)"
          : target.created
            ? " (new library)"
            : ` (${row.lib} is read-only for you)`}
      </span>
    </span>
  );
}
