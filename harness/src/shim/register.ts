/**
 * Sets up window.ComponentFramework.registerControl interceptor.
 * Must be called BEFORE the PCF bundle script is loaded.
 */

type ControlConstructor = new () => any;

let capturedConstructor: ControlConstructor | null = null;
let capturedFqn: string | null = null;

export function setupRegistrationInterceptor(): void {
  (window as any).ComponentFramework = {
    ...(window as any).ComponentFramework,
    registerControl(fqn: string, ctor: ControlConstructor) {
      capturedFqn = fqn;
      capturedConstructor = ctor;
      console.log(`[pcf-workbench] Registered control: ${fqn}`);
    },
  };
}

export function getCapturedConstructor(): { fqn: string; ctor: ControlConstructor } | null {
  if (!capturedConstructor || !capturedFqn) return null;
  return { fqn: capturedFqn, ctor: capturedConstructor };
}

export function resetCapturedConstructor(): void {
  capturedConstructor = null;
  capturedFqn = null;
}
