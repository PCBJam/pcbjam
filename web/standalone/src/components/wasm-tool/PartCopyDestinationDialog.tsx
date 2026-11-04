import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@pcbjam/ui";
import { usePendingPartCopyDestination } from "@/libs/part-copy-prompt";

/**
 * pricing 0006 T3b: the library browser's "Copy to...". An editor opened from
 * the library browser has no project of its own, so the user picks where the
 * copy goes: the team's default library or a project they can edit.
 */
export function PartCopyDestinationDialog() {
  const pending = usePendingPartCopyDestination();
  if (!pending) return null;
  const { request, answer } = pending;
  return (
    <Dialog open onOpenChange={(open) => !open && answer(null)}>
      <DialogContent data-testid="part-copy-destination-dialog">
        <DialogHeader>
          <DialogTitle>
            Copy {request.lib}:{request.name} to...
          </DialogTitle>
          <DialogDescription>Pick a library. A project keeps its copies in its own library.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto" data-testid="part-copy-destinations">
          {request.destinations.map((d) => (
            <li key={`${d.scope}/${d.project ?? ""}`}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                data-testid="part-copy-destination"
                onClick={() => answer(d)}
              >
                {d.project ? `Project: ${d.label}` : d.label}
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(null)} data-testid="part-copy-destination-cancel">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
