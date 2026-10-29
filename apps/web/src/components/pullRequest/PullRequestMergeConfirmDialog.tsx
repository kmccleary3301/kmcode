import type { PullRequestMergeMethod } from "@t3tools/contracts";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/** The one question every compact Merge button asks before it touches the host. */
export function PullRequestMergeConfirmDialog({
  open,
  onOpenChange,
  number,
  method,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  number: number;
  method: PullRequestMergeMethod;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
          <AlertDialogDescription>
            This merges #{number} using {method}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Merge
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
