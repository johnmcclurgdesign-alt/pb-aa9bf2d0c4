// n8ao's dist build imports { Pass } from "postprocessing" for its pmndrs
// composer flavour (N8AOPostPass). We only use the three-EffectComposer
// flavour (N8AOPass), so the importmap points "postprocessing" at this stub —
// a constructor with the right shape, instead of shipping a whole second
// post-processing library to satisfy one unused import.
export class Pass {
  setSize() {}
  render() {}
  dispose() {}
}
