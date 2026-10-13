// The parts of @novnc/novnc's RFB client (core/rfb.js) the Desktop tab uses; the package ships no types.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; wsProtocols?: string[] });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
  }
}
