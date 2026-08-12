import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  applyProjectArtifactCubeTexture,
  disposeProjectArtifactCubeMaterials,
} from "./projectArtifactThreeResources";

function makeTexture(image: unknown) {
  const texture = new THREE.Texture();
  texture.image = image;
  return texture;
}

describe("project artifact three resources", () => {
  it("disposes generated texture clones when disposing cube materials", () => {
    const source = makeTexture({ src: "memory-a" });
    const material = new THREE.MeshBasicMaterial();
    const sourceDispose = vi.spyOn(source, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");

    const clone = applyProjectArtifactCubeTexture({
      cloneForUvTransform: true,
      material,
      texture: source,
    });
    const cloneDispose = vi.spyOn(clone, "dispose");

    disposeProjectArtifactCubeMaterials([material]);

    expect(clone).not.toBe(source);
    expect(cloneDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(sourceDispose).not.toHaveBeenCalled();
    expect(material.map).toBeNull();
  });

  it("releases a generated texture clone before reusing a shared source texture", () => {
    const source = makeTexture({ src: "memory-a" });
    const material = new THREE.MeshBasicMaterial();
    const clone = applyProjectArtifactCubeTexture({
      cloneForUvTransform: true,
      material,
      texture: source,
    });
    const cloneDispose = vi.spyOn(clone, "dispose");

    applyProjectArtifactCubeTexture({
      cloneForUvTransform: false,
      material,
      texture: source,
    });

    expect(cloneDispose).toHaveBeenCalledOnce();
    expect(material.map).toBe(source);
  });

  it("updates generated texture clones in place when the source image changes", () => {
    const firstSource = makeTexture({ src: "memory-a" });
    const secondSource = makeTexture({ src: "memory-b" });
    const material = new THREE.MeshBasicMaterial();

    const clone = applyProjectArtifactCubeTexture({
      cloneForUvTransform: true,
      material,
      texture: firstSource,
    });
    const cloneVersion = clone.version;
    const cloneDispose = vi.spyOn(clone, "dispose");

    const updatedClone = applyProjectArtifactCubeTexture({
      cloneForUvTransform: true,
      material,
      texture: secondSource,
    });

    expect(updatedClone).toBe(clone);
    expect(updatedClone.image).toBe(secondSource.image);
    expect(updatedClone.version).toBeGreaterThan(cloneVersion);
    expect(cloneDispose).not.toHaveBeenCalled();
  });
});
