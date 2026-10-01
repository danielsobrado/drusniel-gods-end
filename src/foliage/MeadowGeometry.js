import * as THREE from 'three/webgpu';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const point = (x, y, z) => new THREE.Vector3(x, y, z);

// Small, opaque botanical meshes: folded leaf surfaces catch the light without
// alpha cards, while shared vertices keep each instanced clump inexpensive.
class PlantBuilder {
  positions = [];
  colors = [];
  indices = [];

  vertex(position, color) {
    const index = this.positions.length / 3;
    position.toArray(this.positions, index * 3);
    color.toArray(this.colors, index * 3);
    return index;
  }

  triangle(a, b, c) { this.indices.push(a, b, c); }

  leaf(start, end, width, curl, root, tip, twist = 0, segments = 4) {
    const axis = end.clone().sub(start).normalize();
    const side = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) > 0.9 ? FORWARD : UP)
      .normalize().applyAxisAngle(axis, twist);
    const normal = new THREE.Vector3().crossVectors(side, axis).normalize();
    const dark = new THREE.Color(root);
    const light = new THREE.Color(tip);
    let previous = [this.vertex(start, dark)];
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const color = dark.clone().lerp(light, t);
      const center = start.clone().lerp(end, t).addScaledVector(normal, Math.sin(t * Math.PI) * curl);
      let row;
      if (i === segments) row = [this.vertex(end, color)];
      else {
        const w = Math.pow(Math.sin(t * Math.PI), 0.8) * width;
        const edge = center.clone().addScaledVector(normal, -w * 0.32);
        row = [this.vertex(edge.clone().addScaledVector(side, -w), color.clone().multiplyScalar(0.88)),
          this.vertex(center, color), this.vertex(edge.clone().addScaledVector(side, w), color)];
      }
      if (previous.length === 1) {
        this.triangle(previous[0], row[0], row[1]);
        this.triangle(previous[0], row[1], row[2]);
      } else if (row.length === 1) {
        this.triangle(previous[0], row[0], previous[1]);
        this.triangle(previous[1], row[0], previous[2]);
      } else {
        for (let j = 0; j < 2; j++) {
          this.triangle(previous[j], row[j], previous[j + 1]);
          this.triangle(previous[j + 1], row[j], row[j + 1]);
        }
      }
      previous = row;
    }
  }

  stem(points, radius, color = '#507748', sides = 3) {
    const tint = new THREE.Color(color);
    let previous;
    for (let i = 0; i < points.length; i++) {
      const tangent = points[Math.min(i + 1, points.length - 1)].clone()
        .sub(points[Math.max(i - 1, 0)]).normalize();
      const side = new THREE.Vector3().crossVectors(tangent, Math.abs(tangent.z) > 0.9 ? UP : FORWARD).normalize();
      const normal = new THREE.Vector3().crossVectors(side, tangent).normalize();
      const ring = [];
      const ringRadius = Array.isArray(radius) ? radius[i] : radius * (1 - i / (points.length - 1) * 0.65);
      for (let j = 0; j < sides; j++) {
        const angle = j / sides * Math.PI * 2;
        ring.push(this.vertex(points[i].clone().addScaledVector(side, Math.cos(angle) * ringRadius)
          .addScaledVector(normal, Math.sin(angle) * ringRadius), tint));
      }
      if (previous) for (let j = 0; j < sides; j++) {
        const next = (j + 1) % sides;
        this.triangle(previous[j], ring[j], previous[next]);
        this.triangle(previous[next], ring[j], ring[next]);
      }
      previous = ring;
    }
  }

  bud(center, radius, color) {
    const tint = new THREE.Color(color);
    const vertices = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]
      .map(([x, y, z]) => this.vertex(point(x * radius.x, y * radius.y, z * radius.z).add(center),
        tint.clone().multiplyScalar(y < 0 ? 0.75 : 1)));
    for (let i = 0; i < 4; i++) {
      const a = vertices[2 + i], b = vertices[2 + (i + 1) % 4];
      this.triangle(vertices[0], b, a);
      this.triangle(vertices[1], a, b);
    }
  }

  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function fern(builder) {
  for (let f = 0; f < 7; f++) {
    const angle = f * 2.399;
    const reach = 0.66 + (f % 3) * 0.13;
    const forward = point(Math.cos(angle), 0, Math.sin(angle));
    const side = point(-Math.sin(angle), 0, Math.cos(angle));
    const curve = t => forward.clone().multiplyScalar(reach * t)
      .add(point(0, 0.06 + Math.sin(t * Math.PI * 0.78) * (0.52 + (f % 2) * 0.15), 0));
    builder.stem([0, 0.25, 0.5, 0.75, 1].map(curve), 0.011, '#76934b');
    for (let pair = 0; pair < 6; pair++) {
      const t = 0.2 + pair * 0.12;
      const start = curve(t);
      const length = Math.sin((t + 0.08) * Math.PI) * 0.25;
      for (const direction of [-1, 1]) {
        const end = start.clone().addScaledVector(side, direction * length)
          .addScaledVector(forward, length * 0.42).add(point(0, 0.035, 0));
        builder.leaf(start, end, length * 0.22, 0.025, '#326745', '#91b957', direction * 0.25, 3);
      }
    }
    builder.leaf(curve(0.85), curve(1.08), 0.047, 0.02, '#568c48', '#afc976', 0, 3);
  }
}

function flowers(builder) {
  for (let i = 0; i < 5; i++) {
    const angle = i * 2.399;
    builder.leaf(point(0, 0.03, 0), point(Math.cos(angle) * 0.3, 0.23, Math.sin(angle) * 0.3),
      0.07, 0.08, '#346646', '#82ab58', angle * 0.2);
  }
  for (let i = 0; i < 3; i++) {
    const angle = i * 2.399;
    const head = point(Math.cos(angle) * 0.2, 0.76 + i * 0.16, Math.sin(angle) * 0.2);
    const middle = head.clone().multiplyScalar(0.5).add(point(0.05, 0, -0.04));
    builder.stem([point(0, 0, 0), middle, head], 0.013);
    builder.leaf(middle, middle.clone().add(point(-0.18, 0.18, 0.08)), 0.045, 0.035, '#42764c', '#93b967');
    for (let petal = 0; petal < 6; petal++) {
      const a = petal * Math.PI / 3 + i;
      builder.leaf(head, head.clone().add(point(Math.cos(a) * 0.145, 0.04, Math.sin(a) * 0.145)),
        0.049, -0.025, '#dfbc62', i === 1 ? '#fff0c9' : '#edf4df', 0, 3);
      builder.leaf(head.clone().add(point(0, -0.018, 0)),
        head.clone().add(point(Math.cos(a) * 0.08, -0.04, Math.sin(a) * 0.08)),
        0.018, 0.01, '#467247', '#7eaa53', 0, 2);
    }
    builder.bud(head.clone().add(point(0, 0.023, 0)), point(0.042, 0.027, 0.042), '#d8a843');
    for (let stamen = 0; stamen < 4; stamen++) {
      const a = stamen * Math.PI / 2;
      builder.bud(head.clone().add(point(Math.cos(a) * 0.025, 0.043, Math.sin(a) * 0.025)),
        point(0.008, 0.012, 0.008), '#f7df8b');
    }
  }
}

function stalks(builder, reed) {
  for (let i = 0; i < 3; i++) {
    const angle = i * 2.399;
    const base = point(Math.cos(angle) * 0.12, 0, Math.sin(angle) * 0.12);
    const head = base.clone().add(point(Math.sin(angle) * 0.13, (reed ? 1.55 : 0.95) + i * 0.17, 0.08));
    builder.stem([base, base.clone().lerp(head, 0.5), head], reed ? 0.018 : 0.009, reed ? '#64864d' : '#8c9454');
    for (let j = 0; j < 3; j++) {
      const a = angle + j * 2.399;
      const start = base.clone().lerp(head, 0.14 + j * 0.2);
      builder.leaf(start, start.clone().add(point(Math.cos(a) * (reed ? 0.43 : 0.27), 0.25, Math.sin(a) * 0.35)),
        reed ? 0.035 : 0.022, 0.16, '#487b49', '#b6bf6c', Math.sin(a) * 0.35, 4);
    }
    if (reed) {
      // A faceted cattail with a narrow flowering spike above the velvet head.
      builder.stem([-0.23, -0.19, 0.04, 0.08].map(y => head.clone().add(point(0, y, 0))),
        [0.015, 0.048, 0.048, 0.012], '#795635', 6);
      builder.stem([head.clone().add(point(0, 0.07, 0)), head.clone().add(point(0, 0.22, 0))], 0.01, '#b9a166');
    } else {
      for (let j = 0; j < 7; j++) {
        const a = angle + j * 2.399;
        const start = head.clone().add(point(0, -0.25 + j * 0.044, 0));
        const reach = 0.13 * (1 - j / 9);
        const end = start.clone().add(point(Math.cos(a) * reach, 0.095, Math.sin(a) * reach));
        builder.stem([start, end], 0.004, '#b8ad70');
        builder.bud(end, point(0.022, 0.051, 0.022), j % 2 ? '#ceb779' : '#a7aa64');
      }
    }
  }
}

export function createMeadowGeometry(type) {
  const builder = new PlantBuilder();
  if (type === 'fern') fern(builder);
  else if (type === 'flower') flowers(builder);
  else if (type === 'seed' || type === 'reed') stalks(builder, type === 'reed');
  else if (type === 'litter') {
    for (let i = 0; i < 4; i++) {
      const angle = i * 2.399;
      const start = point(Math.cos(angle) * 0.09, 0.03 + i * 0.007, Math.sin(angle) * 0.1);
      const end = start.clone().add(point(Math.cos(angle) * 0.28, 0.035, Math.sin(angle) * 0.28));
      builder.leaf(start, end, 0.075, 0.055, '#685b35', i % 2 ? '#aa8649' : '#b3a563');
      builder.stem([start, start.clone().lerp(end, 0.5).add(point(0, 0.052, 0)), end], 0.003, '#c2aa71');
    }
  } else if (type === 'stone') {
    const geometry = new THREE.IcosahedronGeometry(0.2, 1);
    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const p = point(position.getX(i), position.getY(i), position.getZ(i));
      p.x *= 1.4 + Math.sin(p.y * 21 + p.z * 12) * 0.12;
      p.y = p.y * 0.55 + 0.065;
      p.z *= 0.9;
      const moss = THREE.MathUtils.smoothstep(p.y + Math.sin(p.x * 25) * 0.035, 0.035, 0.16);
      const tint = new THREE.Color('#777b70').lerp(new THREE.Color('#729151'), moss * 0.8);
      const index = builder.vertex(p, tint);
      if (i % 3 === 2) builder.triangle(index - 2, index - 1, index);
    }
    geometry.dispose();
  } else throw new Error(`Unknown meadow plant: ${type}`);
  return builder.build();
}
