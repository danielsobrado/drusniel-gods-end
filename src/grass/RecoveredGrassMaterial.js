import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  cameraPosition as cameraPositionNode,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  materialOpacity,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  normalWorld,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const DEG_TO_RAD = Math.PI / 180;
const HASH_SCALE = 43758.5453;
const CLIP_Y_MARGIN = 10;
const CLIP_XZ_MARGIN = 2;
const GRASS_CUTOFF = 0.05;
const INTERACTION_EPSILON = 0.00201;
const WIND_EPSILON = 0.001;
const BILLBOARD_ALPHA_TEST = 0.5;
const ATLAS_PADDING = 0.03;

const gradientNoise2d = Fn(([point]) => {
  const cell = floor(point).toVar();
  const local = fract(point).toVar();
  const fade = local.mul(local).mul(float(3).sub(local.mul(2)));

  const gradientDot = (offset) => {
    const lattice = cell.add(offset);
    const angle = fract(sin(dot(lattice, vec2(0.1, 0.7))).mul(HASH_SCALE)).mul(TWO_PI);
    const delta = local.sub(offset);
    return cos(angle).mul(delta.x).add(sin(angle).mul(delta.y));
  };

  return mix(
    mix(gradientDot(vec2(0, 0)), gradientDot(vec2(1, 0)), fade.x),
    mix(gradientDot(vec2(0, 1)), gradientDot(vec2(1, 1)), fade.x),
    fade.y,
  ).add(0.5);
});

export class GrassMaterial {
  constructor(config, terrainSampler, grassMask, interactionMap, type = config.grass.type, atlasTexture = null) {
    this.config = config;
    this.type = type;
    this.painterEnabled = Boolean(config.painter.enabled);
    const terrain = terrainSampler.getShaderData();
    const interaction = interactionMap.getShaderData();
    const grass = config.grass[type];

    this.uniforms = {
      time: uniform(0),
      bladeWidth: uniform(grass.bladeWidth),
      bladeHeight: uniform(grass.bladeHeight),
      bladeStiffness: uniform(grass.bladeStiffness ?? 1),
      baseBend: uniform(grass.baseBend ?? 0),
      windIntensity: uniform(grass.windIntensity),
      windDirection: uniform(grass.windDirection),
      windNoiseScale: uniform(grass.windNoiseScale),
      simulationSpeed: uniform(grass.simulationSpeed),
      sheen: uniform(type === 'billboard' ? 0.25 : (grass.sheen ?? 0.25)),
      baseColor: uniform(new THREE.Color(grass.baseColor)),
      tipColor: uniform(new THREE.Color(grass.tipColor)),
      cameraPosition: uniform(new THREE.Vector3()),
      viewProjection: uniform(new THREE.Matrix4()),
      maxDistance: uniform(config.grass.maxDistance),
      terrainMin: uniform(terrain.boundsMin.clone()),
      terrainMax: uniform(terrain.boundsMin.clone().add(terrain.boundsSize)),
      terrainSize: uniform(terrain.boundsSize.clone()),
      minHeight: uniform(terrain.minHeight),
      maxHeight: uniform(terrain.maxHeight),
      interactionCenter: uniform(interaction.center),
      interactionWorldSize: uniform(interaction.worldSize),
    };

    this.material = this.#createMaterial(
      terrain.texture,
      grassMask.texture,
      interaction.texture,
      atlasTexture,
    );
  }

  #createMaterial(heightTexture, maskTexture, interactionTexture, atlasTexture) {
    const instancePosition = attribute('instancePosition', 'vec3');
    const instanceRotation = attribute('instanceRotation', 'vec2');
    const instanceData = attribute('instanceData', 'vec4');
    const bladeSide = attribute('bladeSide', 'float');
    const bladeUv = uv();
    const positionNode = this.type === 'billboard'
      ? this.#createBillboardPositionNode(
        heightTexture,
        maskTexture,
        interactionTexture,
        instancePosition,
        instanceRotation,
        instanceData,
      )
      : this.#createBladePositionNode(
        heightTexture,
        maskTexture,
        interactionTexture,
        instancePosition,
        instanceRotation,
        instanceData,
        bladeUv,
      );

    const normalNode = Fn(() => {
      const side = bladeSide.clamp(-1, 1);
      const sideDirection = vec3(instanceRotation.y, 0, instanceRotation.x.negate());
      const forwardDirection = vec3(instanceRotation.x, 0, instanceRotation.y);
      return normalize(
        vec3(0, 1, 0)
          .add(sideDirection.mul(side).mul(0.12))
          .add(forwardDirection.mul(0.15)),
      );
    })();

    const material = new THREE.MeshStandardNodeMaterial();
    material.positionNode = positionNode;
    material.normalNode = normalNode;
    material.side = THREE.DoubleSide;
    material.depthWrite = true;
    material.depthTest = true;

    if (this.type === 'billboard' && atlasTexture) {
      this.#configureBillboardMaterial(material, atlasTexture, bladeUv, instanceData);
    } else {
      material.receivedShadowPositionNode = positionNode;
      this.#configureBladeMaterial(material, bladeUv, instanceData);
    }
    return material;
  }

  #createVisibility(baseWorld, terrainHeight) {
    const uniforms = this.uniforms;
    const terrainPoint = vec3(baseWorld.x, terrainHeight, baseWorld.z);
    const clip = uniforms.viewProjection.mul(vec4(terrainPoint, 1));
    const clipY = clip.w.add(CLIP_Y_MARGIN);
    const clipXZ = clip.w.add(CLIP_XZ_MARGIN);
    const distanceX = baseWorld.x.sub(uniforms.cameraPosition.x);
    const distanceZ = baseWorld.z.sub(uniforms.cameraPosition.z);
    const distance = sqrt(distanceX.mul(distanceX).add(distanceZ.mul(distanceZ)));

    const bounds = this.type === 'blade'
      ? baseWorld.x.greaterThanEqual(uniforms.terrainMin.x.mul(0.99))
        .and(baseWorld.x.lessThanEqual(uniforms.terrainMax.x.mul(0.99)))
        .and(baseWorld.z.greaterThanEqual(uniforms.terrainMin.z.mul(0.99)))
        .and(baseWorld.z.lessThanEqual(uniforms.terrainMax.z.mul(0.99)))
      : baseWorld.x.greaterThanEqual(uniforms.terrainMin.x)
        .and(baseWorld.x.lessThanEqual(uniforms.terrainMax.x))
        .and(baseWorld.z.greaterThanEqual(uniforms.terrainMin.z))
        .and(baseWorld.z.lessThanEqual(uniforms.terrainMax.z));

    const frustum = clip.x.abs().lessThanEqual(clipXZ)
      .and(clip.y.abs().lessThanEqual(clipY))
      .and(clip.z.greaterThanEqual(0))
      .and(clip.z.lessThanEqual(clipXZ));
    const withinDistance = distance.lessThanEqual(uniforms.maxDistance);
    return {
      distance,
      visible: this.painterEnabled
        ? float(1).greaterThan(0)
        : bounds.and(frustum).and(withinDistance),
    };
  }

  #sampleTerrain(heightTexture, baseWorld) {
    const uniforms = this.uniforms;
    const terrainUv = vec2(
      baseWorld.x.sub(uniforms.terrainMin.x).div(uniforms.terrainSize.x).clamp(0, 1),
      baseWorld.z.sub(uniforms.terrainMin.z).div(uniforms.terrainSize.z).clamp(0, 1),
    );
    return {
      terrainUv,
      height: mix(
        uniforms.minHeight,
        uniforms.maxHeight,
        texture(heightTexture, terrainUv).r,
      ),
    };
  }

  #sampleInteractionBlade(interactionTexture, baseWorld, local, grassStrength) {
    const uniforms = this.uniforms;
    const interactionUv = baseWorld.xz
      .sub(uniforms.interactionCenter)
      .div(uniforms.interactionWorldSize)
      .add(0.5);
    const inside = interactionUv.x.greaterThanEqual(0)
      .and(interactionUv.x.lessThanEqual(1))
      .and(interactionUv.y.greaterThanEqual(0))
      .and(interactionUv.y.lessThanEqual(1));
    const influence = float(0).toVar();

    If(inside, () => {
      influence.assign(texture(interactionTexture, interactionUv.clamp(0, 1)).r);
    });

    const amount = smoothstep(0, 0.15, influence);
    const directionX = float(0).toVar();
    const directionZ = float(0).toVar();
    const interactionAngle = float(0).toVar();

    If(amount.greaterThan(0), () => {
      const angle = fract(
        sin(dot(baseWorld.xz, vec2(0.9898, 0.2330))).mul(HASH_SCALE),
      ).mul(TWO_PI);
      directionX.assign(cos(angle));
      directionZ.assign(sin(angle));
      interactionAngle.assign(amount.mul(HALF_PI));
    });

    const directionLength = sqrt(
      directionX.mul(directionX).add(directionZ.mul(directionZ)),
    );
    const safeLength = max(directionLength, INTERACTION_EPSILON);
    directionX.divAssign(safeLength);
    directionZ.divAssign(safeLength);

    const heightRatio = local.y.div(uniforms.bladeHeight).clamp(0, 1);
    const curve = interactionAngle.mul(3);
    const horizontal = uniforms.bladeHeight
      .mul(grassStrength)
      .mul(sin(curve.mul(heightRatio)))
      .mul(heightRatio);
    local.x.addAssign(directionX.mul(horizontal));
    local.z.addAssign(directionZ.mul(horizontal));
    local.y.assign(local.y.mul(cos(curve.mul(heightRatio))));
  }

  #sampleInteractionBillboard(interactionTexture, baseWorld, local) {
    const uniforms = this.uniforms;
    const interactionUv = baseWorld.xz
      .sub(uniforms.interactionCenter)
      .div(uniforms.interactionWorldSize)
      .add(0.5)
      .clamp(0, 1);
    const amount = smoothstep(0, 0.15, texture(interactionTexture, interactionUv).r);
    const directionX = float(0).toVar();
    const directionZ = float(0).toVar();
    const interactionAngle = float(0).toVar();

    If(amount.greaterThan(0), () => {
      const angle = fract(
        sin(dot(baseWorld.xz, vec2(0.9898, 0.2330))).mul(HASH_SCALE),
      ).mul(TWO_PI);
      directionX.assign(cos(angle));
      directionZ.assign(sin(angle));
      interactionAngle.assign(amount.mul(HALF_PI));
    });

    const directionLength = sqrt(
      directionX.mul(directionX).add(directionZ.mul(directionZ)),
    );
    const safeLength = max(directionLength, 0.0001);
    directionX.divAssign(safeLength);
    directionZ.divAssign(safeLength);

    const heightRatio = local.y.div(uniforms.bladeHeight).clamp(0, 1);
    const curve = interactionAngle.mul(2);
    const horizontal = uniforms.bladeHeight
      .mul(sin(curve.mul(heightRatio)))
      .mul(heightRatio);
    local.x.addAssign(directionX.mul(horizontal));
    local.z.addAssign(directionZ.mul(horizontal));
    local.y.assign(local.y.mul(cos(curve.mul(heightRatio))));
  }

  #rotateInstance(local, instanceRotation) {
    const sourceX = local.x;
    const sourceZ = local.z;
    local.x.assign(sourceX.mul(instanceRotation.y).sub(sourceZ.mul(instanceRotation.x)));
    local.z.assign(sourceX.mul(instanceRotation.x).add(sourceZ.mul(instanceRotation.y)));
  }

  #createBladePositionNode(
    heightTexture,
    maskTexture,
    interactionTexture,
    instancePosition,
    instanceRotation,
    instanceData,
    bladeUv,
  ) {
    const uniforms = this.uniforms;

    return Fn(() => {
      const local = positionLocal.toVar();
      const baseWorld = modelWorldMatrix.mul(vec4(instancePosition, 1)).xyz;
      const terrain = this.#sampleTerrain(heightTexture, baseWorld);
      const visibility = this.#createVisibility(baseWorld, terrain.height);

      If(visibility.visible.not(), () => {
        local.assign(vec3(1e9));
      });

      If(visibility.visible, () => {
        const grassStrength = oneMinus(texture(maskTexture, terrain.terrainUv).r);
        this.#sampleInteractionBlade(interactionTexture, baseWorld, local, grassStrength);

        local.x.mulAssign(uniforms.bladeWidth.mul(sqrt(grassStrength)));
        local.y.mulAssign(uniforms.bladeHeight);
        this.#rotateInstance(local, instanceRotation);
        local.x.addAssign(instancePosition.x);
        local.z.addAssign(instancePosition.z);
        local.y.addAssign(terrain.height);

        const detailHeight = float(1).toVar();
        const useDetail = this.painterEnabled
          ? float(1).greaterThan(0)
          : visibility.distance.lessThanEqual(uniforms.maxDistance.mul(0.5));
        If(useDetail, () => {
          const hashA = fract(
            sin(dot(baseWorld.xz.mul(0.15), vec2(0.9898, 0.2330))).mul(HASH_SCALE),
          );
          const hashB = fract(
            sin(dot(baseWorld.xz, vec2(0.3468, 0.1357))).mul(24634.6345),
          );
          const detailNoise = pow(hashA.mul(0.7).add(hashB.mul(0.3)), 0.6);
          detailHeight.assign(mix(0.1, 0.5, detailNoise));
        });

        const heightFromTerrain = local.y.sub(terrain.height);
        local.y.assign(
          terrain.height.add(heightFromTerrain.mul(detailHeight).mul(grassStrength)),
        );

        If(grassStrength.lessThan(GRASS_CUTOFF), () => {
          local.assign(vec3(1e9));
        });

        const heightRatio = bladeUv.y.clamp(0, 1);
        const randomDirectionX = cos(instanceData.z);
        const randomDirectionZ = sin(instanceData.z);
        const windDirectionX = float(0).toVar();
        const windDirectionZ = float(0).toVar();
        const windAngle = float(0).toVar();
        const useDetailedWind = this.painterEnabled
          ? float(1).greaterThan(0)
          : visibility.distance.lessThanEqual(uniforms.maxDistance.mul(0.7));

        If(useDetailedWind, () => {
          const clock = uniforms.time.mul(uniforms.simulationSpeed);
          const point = baseWorld.xz
            .mul(uniforms.windNoiseScale)
            .add(vec2(clock, clock));
          const noiseX = gradientNoise2d(point).sub(0.5).mul(2);
          const noiseZ = gradientNoise2d(point.add(vec2(0.7, 0.3))).sub(0.5).mul(2);
          const direction = uniforms.windDirection.mul(DEG_TO_RAD);
          const directionCos = cos(direction);
          const directionSin = sin(direction);
          const rotatedX = noiseX.mul(directionCos).sub(noiseZ.mul(directionSin));
          const rotatedZ = noiseX.mul(directionSin).add(noiseZ.mul(directionCos));
          const magnitude = sqrt(rotatedX.mul(rotatedX).add(rotatedZ.mul(rotatedZ)));
          let normalizedX = rotatedX.div(max(magnitude, WIND_EPSILON));
          let normalizedZ = rotatedZ.div(max(magnitude, WIND_EPSILON));
          const normalizedLength = sqrt(
            normalizedX.mul(normalizedX).add(normalizedZ.mul(normalizedZ)),
          );
          const safeLength = max(normalizedLength, WIND_EPSILON);
          normalizedX = normalizedX.div(safeLength);
          normalizedZ = normalizedZ.div(safeLength);
          windDirectionX.assign(normalizedX);
          windDirectionZ.assign(normalizedZ);
          windAngle.assign(
            magnitude
              .mul(0.3)
              .mul(uniforms.windIntensity)
              .mul(grassStrength)
              .mul(HALF_PI),
          );
        });

        If(useDetailedWind.not(), () => {
          const clock = uniforms.time.mul(uniforms.simulationSpeed).mul(2);
          const direction = uniforms.windDirection.mul(DEG_TO_RAD);
          const globalX = cos(direction);
          const globalZ = sin(direction);
          const along = baseWorld.x.mul(globalX).add(baseWorld.z.mul(globalZ));
          const across = baseWorld.x.mul(globalZ).sub(baseWorld.z.mul(globalX));
          const waveA = sin(along.mul(uniforms.windNoiseScale).add(clock));
          const waveB = cos(
            across
              .mul(uniforms.windNoiseScale)
              .mul(0.5)
              .add(clock.mul(0.7)),
          );
          const gust = waveA
            .mul(0.5)
            .add(0.5)
            .mul(waveB.mul(0.25).add(0.75))
            .mul(0.3);
          const mixedX = mix(globalX, randomDirectionX, 0.2);
          const mixedZ = mix(globalZ, randomDirectionZ, 0.2);
          const magnitude = sqrt(mixedX.mul(mixedX).add(mixedZ.mul(mixedZ)));
          const safeMagnitude = max(magnitude, WIND_EPSILON);
          windDirectionX.assign(mixedX.div(safeMagnitude));
          windDirectionZ.assign(mixedZ.div(safeMagnitude));
          windAngle.assign(
            gust.mul(uniforms.windIntensity).mul(grassStrength).mul(HALF_PI),
          );
        });

        const bendPower = pow(heightRatio, uniforms.bladeStiffness);
        const baseAngle = uniforms.baseBend
          .mul(grassStrength)
          .mul(HALF_PI)
          .mul(bendPower);
        const baseHorizontal = uniforms.bladeHeight
          .mul(sin(baseAngle))
          .mul(heightRatio);
        local.x.addAssign(randomDirectionX.mul(baseHorizontal));
        local.z.addAssign(randomDirectionZ.mul(baseHorizontal));
        local.y.subAssign(
          uniforms.bladeHeight
            .mul(cos(baseAngle).sub(1))
            .mul(heightRatio)
            .abs(),
        );

        const animatedAngle = windAngle.mul(bendPower);
        const windHorizontal = uniforms.bladeHeight
          .mul(sin(animatedAngle))
          .mul(heightRatio);
        local.x.addAssign(windDirectionX.mul(windHorizontal));
        local.z.addAssign(windDirectionZ.mul(windHorizontal));
        local.y.subAssign(
          uniforms.bladeHeight
            .mul(cos(animatedAngle).sub(1))
            .mul(heightRatio)
            .abs(),
        );

        local.assign(mix(vec3(local.x, terrain.height, local.z), local, materialOpacity));
      });

      return local;
    })();
  }

  #createBillboardPositionNode(
    heightTexture,
    maskTexture,
    interactionTexture,
    instancePosition,
    instanceRotation,
    instanceData,
  ) {
    const uniforms = this.uniforms;

    return Fn(() => {
      const local = positionLocal.toVar();
      const baseWorld = modelWorldMatrix.mul(vec4(instancePosition, 1)).xyz;
      const terrain = this.#sampleTerrain(heightTexture, baseWorld);
      const visibility = this.#createVisibility(baseWorld, terrain.height);

      If(visibility.visible.not(), () => {
        local.assign(vec3(1e9));
      });

      If(visibility.visible, () => {
        const grassStrength = oneMinus(texture(maskTexture, terrain.terrainUv).r);
        const strengthRoot = sqrt(grassStrength);
        this.#sampleInteractionBillboard(interactionTexture, baseWorld, local);

        const sourceX = local.x;
        const sourceZ = local.z;
        const rotatedX = sourceX
          .mul(instanceRotation.y)
          .sub(sourceZ.mul(instanceRotation.x));
        const rotatedZ = sourceX
          .mul(instanceRotation.x)
          .add(sourceZ.mul(instanceRotation.y));
        local.assign(vec3(
          rotatedX.mul(uniforms.bladeWidth.mul(strengthRoot)),
          local.y.mul(uniforms.bladeHeight),
          rotatedZ.mul(uniforms.bladeWidth.mul(strengthRoot)),
        ));
        local.x.addAssign(instancePosition.x);
        local.z.addAssign(instancePosition.z);
        local.y.addAssign(terrain.height);

        const detailHeight = float(1).toVar();
        const useDetail = this.painterEnabled
          ? float(1).greaterThan(0)
          : visibility.distance.lessThanEqual(uniforms.maxDistance.mul(0.5));
        If(useDetail, () => {
          const hashA = fract(
            sin(dot(instancePosition.xz.mul(0.15), vec2(0.9898, 0.2330))).mul(HASH_SCALE),
          );
          const hashB = fract(
            sin(dot(instancePosition.xz, vec2(0.3468, 0.1357))).mul(24634.6345),
          );
          const detailNoise = pow(hashA.mul(0.7).add(hashB.mul(0.3)), 0.6);
          detailHeight.assign(mix(0.1, 1.8, detailNoise));
        });

        const heightFromTerrain = local.y.sub(terrain.height);
        local.y.assign(
          terrain.height.add(heightFromTerrain.mul(detailHeight).mul(grassStrength)),
        );

        If(grassStrength.lessThan(GRASS_CUTOFF), () => {
          local.assign(vec3(1e9));
        });

        const heightRatio = uv().y.clamp(0, 1);
        const useDetailedWind = this.painterEnabled
          ? float(1).greaterThan(0)
          : visibility.distance.lessThanEqual(uniforms.maxDistance.mul(0.7));
        const windDirectionX = float(0).toVar();
        const windDirectionZ = float(0).toVar();
        const windAngle = float(0).toVar();
        const randomDirectionX = cos(instanceData.z);
        const randomDirectionZ = sin(instanceData.z);

        If(useDetailedWind, () => {
          const clock = uniforms.time.mul(uniforms.simulationSpeed);
          const point = instancePosition.xz
            .mul(uniforms.windNoiseScale)
            .add(vec2(clock, clock));
          const noiseX = gradientNoise2d(point).sub(0.5).mul(2);
          const noiseZ = gradientNoise2d(point.add(vec2(0.7, 0.3))).sub(0.5).mul(2);
          const direction = uniforms.windDirection.mul(DEG_TO_RAD);
          const globalX = cos(direction);
          const globalZ = sin(direction);
          const rotatedNoiseX = noiseX.mul(globalX).sub(noiseZ.mul(globalZ));
          const rotatedNoiseZ = noiseX.mul(globalZ).add(noiseZ.mul(globalX));
          const magnitude = sqrt(
            rotatedNoiseX.mul(rotatedNoiseX).add(rotatedNoiseZ.mul(rotatedNoiseZ)),
          );
          const mixedX = mix(
            rotatedNoiseX.div(max(magnitude, WIND_EPSILON)),
            randomDirectionX,
            0.2,
          );
          const mixedZ = mix(
            rotatedNoiseZ.div(max(magnitude, WIND_EPSILON)),
            randomDirectionZ,
            0.2,
          );
          const mixedLength = sqrt(mixedX.mul(mixedX).add(mixedZ.mul(mixedZ)));
          const safeLength = max(mixedLength, WIND_EPSILON);
          windDirectionX.assign(mixedX.div(safeLength));
          windDirectionZ.assign(mixedZ.div(safeLength));
          windAngle.assign(
            magnitude
              .mul(0.3)
              .mul(uniforms.windIntensity)
              .mul(grassStrength)
              .mul(HALF_PI),
          );
        });

        If(useDetailedWind.not(), () => {
          const clock = uniforms.time.mul(uniforms.simulationSpeed).mul(2);
          const direction = uniforms.windDirection.mul(DEG_TO_RAD);
          const globalX = cos(direction);
          const globalZ = sin(direction);
          const along = instancePosition.x.mul(globalX).add(instancePosition.z.mul(globalZ));
          const across = instancePosition.x.mul(globalZ).sub(instancePosition.z.mul(globalX));
          const waveA = sin(along.mul(uniforms.windNoiseScale).add(clock));
          const waveB = cos(
            across
              .mul(uniforms.windNoiseScale)
              .mul(0.5)
              .add(clock.mul(0.7)),
          );
          const gust = waveA
            .mul(0.5)
            .add(0.5)
            .mul(waveB.mul(0.25).add(0.75))
            .mul(0.2);
          const mixedX = mix(globalX, randomDirectionX, 0.2);
          const mixedZ = mix(globalZ, randomDirectionZ, 0.2);
          const magnitude = sqrt(mixedX.mul(mixedX).add(mixedZ.mul(mixedZ)));
          const safeMagnitude = max(magnitude, WIND_EPSILON);
          windDirectionX.assign(mixedX.div(safeMagnitude));
          windDirectionZ.assign(mixedZ.div(safeMagnitude));
          windAngle.assign(
            gust.mul(uniforms.windIntensity).mul(grassStrength).mul(HALF_PI),
          );
        });

        const bendPower = pow(heightRatio, 3);
        const animatedAngle = windAngle.mul(bendPower);
        const horizontal = uniforms.bladeHeight
          .mul(sin(animatedAngle))
          .mul(heightRatio);
        local.x.addAssign(windDirectionX.mul(horizontal));
        local.z.addAssign(windDirectionZ.mul(horizontal));
        local.y.subAssign(
          uniforms.bladeHeight
            .mul(cos(animatedAngle).sub(1))
            .mul(heightRatio)
            .abs(),
        );

        local.assign(mix(vec3(local.x, terrain.height, local.z), local, materialOpacity));
      });

      return local;
    })();
  }

  #configureBladeMaterial(material, bladeUv, instanceData) {
    const variation = instanceData.w;
    const heightBrightness = oneMinus(pow(oneMinus(bladeUv.y), 1.8).mul(0.6))
      .mul(smoothstep(0, 0.08, bladeUv.y).mul(0.7).add(0.3));
    const colorHeight = bladeUv.y.add(variation.sub(0.5).mul(0.35)).clamp(0, 1).pow(3);
    const baseColor = this.uniforms.baseColor.mul(mix(0.96, 1.04, variation));
    const tipColor = this.uniforms.tipColor.mul(mix(0.98, 1.02, variation));
    const gradientColor = mix(baseColor, tipColor, colorHeight);
    const variationTint = mix(
      vec3(0.98, 0.99, 0.96),
      vec3(1.02, 1.01, 1),
      variation,
    );
    const viewDirection = this.uniforms.cameraPosition.sub(positionWorld).normalize();
    const viewSheen = pow(
      oneMinus(clamp(dot(normalWorld.normalize(), viewDirection), 0, 1)),
      5,
    ).mul(smoothstep(0.8, 1, bladeUv.y)).mul(this.uniforms.sheen);

    material.colorNode = gradientColor
      .mul(variationTint)
      .mul(heightBrightness)
      .add(vec3(viewSheen));
  }

  #configureBillboardMaterial(material, atlasTexture, bladeUv, instanceData) {
    const columns = uniform(this.config.grass.atlasColumns ?? 2);
    const rows = uniform(this.config.grass.atlasRows ?? 2);
    const cell = vec2(float(1).div(columns), float(1).div(rows));
    const index = instanceData.x;
    const column = index.mod(columns);
    const row = floor(index.div(columns));
    const atlasUv = bladeUv
      .mul(cell.sub(ATLAS_PADDING * 2))
      .add(vec2(
        column.mul(cell.x).add(ATLAS_PADDING),
        row.mul(cell.y).add(ATLAS_PADDING),
      ));
    const atlasSample = texture(atlasTexture, atlasUv);
    const variation = instanceData.w;
    const heightBrightness = oneMinus(pow(oneMinus(bladeUv.y), 0.8).mul(0.6))
      .mul(smoothstep(0, 0.08, bladeUv.y).mul(0.7).add(0.3));
    const colorHeight = bladeUv.y.add(variation.sub(0.5).mul(0.2)).clamp(0, 1).pow(3);
    const baseColor = this.uniforms.baseColor.mul(mix(0.95, 1.04, variation));
    const tipColor = this.uniforms.tipColor.mul(mix(0.98, 1.02, variation));
    const proceduralColor = mix(baseColor, tipColor, colorHeight).mul(mix(
      vec3(0.95, 0.98, 0.92),
      vec3(1.05, 1.02, 0.95),
      variation,
    ));
    const selectedColor = this.config.grass.useTextureColor
      ? atlasSample.rgb
      : proceduralColor;
    const viewDirection = cameraPositionNode.sub(positionWorld).normalize();
    const viewSheen = pow(
      oneMinus(clamp(dot(normalWorld.normalize(), viewDirection), 0, 1)),
      5,
    ).mul(smoothstep(0.7, 1, bladeUv.y)).mul(this.uniforms.sheen);

    material.colorNode = selectedColor.mul(heightBrightness).add(vec3(viewSheen));
    material.opacityNode = atlasSample.a;
    material.alphaTestNode = float(BILLBOARD_ALPHA_TEST);
    material.transparent = false;
  }

  setPreset(params) {
    const grass = this.uniforms;
    grass.bladeWidth.value = params.bladeWidth;
    grass.bladeHeight.value = params.bladeHeight;
    grass.bladeStiffness.value = params.bladeStiffness ?? grass.bladeStiffness.value;
    grass.baseBend.value = params.baseBend ?? grass.baseBend.value;
    grass.windIntensity.value = params.windIntensity;
    grass.windDirection.value = params.windDirection;
    grass.windNoiseScale.value = params.windNoiseScale;
    grass.simulationSpeed.value = params.simulationSpeed;
    if (this.type !== 'billboard') grass.sheen.value = params.sheen ?? 0.25;
    grass.baseColor.value.set(params.baseColor);
    grass.tipColor.value.set(params.tipColor);
  }

  setParameter(name, value) {
    const target = this.uniforms[name];
    if (!target || typeof target.value !== 'number') return;
    target.value = value;
  }

  setFrame(elapsedSeconds, cameraPosition) {
    this.uniforms.time.value = elapsedSeconds;
    this.uniforms.cameraPosition.value.copy(cameraPosition);
  }

  setViewProjection(matrix) {
    this.uniforms.viewProjection.value.copy(matrix);
  }

  setMaxDistance(value) {
    this.uniforms.maxDistance.value = value;
  }

  setInteractionCenter(center) {
    this.uniforms.interactionCenter.value.copy(center);
  }

  setBladeHeight(value) {
    this.uniforms.bladeHeight.value = value;
  }

  dispose() {
    this.material.dispose();
  }
}
