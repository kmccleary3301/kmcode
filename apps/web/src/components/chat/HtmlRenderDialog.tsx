import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { composerFloatingLayerProps } from "./composerEventScope";

export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
        initialFocus={closeButtonRef}
      >
        <DialogTitle className="sr-only">Expanded {props.title} preview</DialogTitle>
        <div className="relative w-[92vw]">
          <Button
            ref={closeButtonRef}
            type="button"
            aria-label="Close"
            size="icon-xs"
            variant="media-close"
            className="absolute right-0 -top-10 z-20"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
          <div className="h-[min(86vh,calc(100vh-160px))] overflow-auto overscroll-contain rounded-lg bg-background shadow-2xl ring-1 ring-border/70 [container-type:size]">
            <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
              <HtmlRenderDocument src={props.src} title={props.title} className="block size-full" />
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
            <span className="truncate">{props.title}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                aria-label="Zoom out"
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 0.5}
                onClick={() => setZoom((value) => value - 0.25)}
              >
                <MinusIcon />
              </Button>
              <Button
                type="button"
                aria-label="Reset zoom"
                size="sm"
                variant="overlay"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                type="button"
                aria-label="Zoom in"
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 2}
                onClick={() => setZoom((value) => value + 0.25)}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
