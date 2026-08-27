export interface RunSignalController {
  readonly signal: AbortSignal;
  handleInterrupt(): void;
}

export function createRunSignalController(forceExit: (code: number) => void): RunSignalController {
  const controller = new AbortController();
  let interrupts = 0;
  return {
    signal: controller.signal,
    handleInterrupt: () => {
      interrupts += 1;
      if (interrupts === 1) {
        controller.abort(new Error("Run cancelled by user"));
        return;
      }
      forceExit(130);
    },
  };
}
