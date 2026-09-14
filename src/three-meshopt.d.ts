declare module "three/examples/jsm/libs/meshopt_decoder.module.js" {
  export const MeshoptDecoder: {
    supported: boolean;
    ready: Promise<void>;
    decodeGltfBuffer: (
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ) => void;
    decodeGltfBufferAsync: (
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ) => Promise<Uint8Array>;
  };
}
