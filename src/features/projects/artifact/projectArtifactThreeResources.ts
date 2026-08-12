import type * as THREE from "three";

const CUBE_TEXTURE_CLONE_FLAG = "projectArtifactRendererCubeTextureClone";
const SOURCE_TEXTURE_UUID = "sourceTextureUuid";

interface ProjectArtifactTextureUserData {
  [CUBE_TEXTURE_CLONE_FLAG]?: boolean;
  [SOURCE_TEXTURE_UUID]?: string;
}

function textureUserData(
  texture: THREE.Texture,
): ProjectArtifactTextureUserData {
  return texture.userData as ProjectArtifactTextureUserData;
}

function isCubeTextureClone(
  texture: THREE.Texture | null | undefined,
): texture is THREE.Texture {
  return Boolean(texture && textureUserData(texture)[CUBE_TEXTURE_CLONE_FLAG]);
}

function createCubeTextureClone(texture: THREE.Texture) {
  const clone = texture.clone();
  const userData = textureUserData(clone);
  userData[CUBE_TEXTURE_CLONE_FLAG] = true;
  userData[SOURCE_TEXTURE_UUID] = texture.uuid;
  return clone;
}

function disposeCubeTextureClone(material: THREE.MeshBasicMaterial) {
  if (!isCubeTextureClone(material.map)) {
    return;
  }

  const texture = material.map;
  material.map = null;
  material.needsUpdate = true;
  texture.dispose();
}

export function applyProjectArtifactCubeTexture({
  cloneForUvTransform,
  material,
  texture,
}: {
  cloneForUvTransform: boolean;
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture;
}) {
  if (!cloneForUvTransform) {
    if (material.map !== texture) {
      disposeCubeTextureClone(material);
      material.map = texture;
      material.needsUpdate = true;
    }
    return texture;
  }

  if (!isCubeTextureClone(material.map)) {
    material.map = createCubeTextureClone(texture);
    material.needsUpdate = true;
  }

  const clonedMap = material.map;
  const userData = textureUserData(clonedMap);
  if (userData[SOURCE_TEXTURE_UUID] !== texture.uuid) {
    clonedMap.image = texture.image;
    clonedMap.colorSpace = texture.colorSpace;
    clonedMap.needsUpdate = true;
    userData[SOURCE_TEXTURE_UUID] = texture.uuid;
  }

  return clonedMap;
}

export function disposeProjectArtifactCubeMaterials(
  materials: readonly THREE.MeshBasicMaterial[],
) {
  materials.forEach((material) => {
    disposeCubeTextureClone(material);
    material.dispose();
  });
}
