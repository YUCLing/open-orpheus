import photon from "@silvia-odwyer/photon-node";

export function pngFromIco(icoData: Uint8Array): Uint8Array {
  const icoImage = photon.PhotonImage.new_from_byteslice(icoData);
  const pngData = icoImage.get_bytes();
  return pngData;
}
