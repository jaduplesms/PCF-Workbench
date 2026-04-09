import type { HarnessStore } from '../store/harness-store';

export function createDeviceShim(getState: () => HarnessStore) {
  const log = (method: string, args?: any) =>
    getState().addLogEntry({ category: 'device', method, args });

  return {
    captureAudio(): Promise<any> {
      log('captureAudio');
      return Promise.reject(new Error('[pcf-workbench] captureAudio not supported in harness'));
    },
    captureImage(options?: any): Promise<any> {
      log('captureImage', options);
      // Return a mock 1x1 transparent PNG as base64
      return Promise.resolve({
        fileContent: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualEQAAAABJRU5ErkJggg==',
        fileName: 'capture.png',
        fileSize: 95,
        mimeType: 'image/png',
      });
    },
    captureVideo(): Promise<any> {
      log('captureVideo');
      return Promise.reject(new Error('[pcf-workbench] captureVideo not supported in harness'));
    },
    getBarcodeValue(): Promise<string> {
      log('getBarcodeValue');
      return Promise.resolve('MOCK-BARCODE-12345');
    },
    getCurrentPosition(): Promise<any> {
      log('getCurrentPosition');
      return Promise.resolve({
        coords: { latitude: 51.5074, longitude: -0.1278, accuracy: 10 },
        timestamp: Date.now(),
      });
    },
    pickFile(options?: any): Promise<any[]> {
      log('pickFile', options);
      return Promise.resolve([]);
    },
  };
}
