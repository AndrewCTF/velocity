"""OBJ + MTL + JPEG texture exporter for decoded C3M tiles."""

from pathlib import Path
from .c3m import C3M


class OBJExporter:
    def __init__(self, out_dir: str, prefix: str = "exp_"):
        self.dir = Path(out_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.prefix = prefix
        self.vtx_count = 0
        self._obj = open(self.dir / f"{prefix}model.obj", "w")
        self._mtl = open(self.dir / f"{prefix}model.mtl", "w")
        self._tile_idx = 0

    def close(self):
        self._obj.close()
        self._mtl.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def add_tile(self, c3m: C3M):
        sub = str(self._tile_idx)
        self._tile_idx += 1
        h = c3m.header

        for i, mat in enumerate(c3m.materials):
            ext = "heic" if mat.is_heif else "jpg"
            tex_name = f"{self.prefix}{sub}_{i}.{ext}"
            (self.dir / tex_name).write_bytes(mat.jpeg)
            self._mtl.write(
                f"\nnewmtl mtl_{sub}_{i}\n"
                f"Kd 1.000 1.000 1.000\nd 1.0\nillum 0\n"
                f"map_Kd {tex_name}\n"
            )

        for mi, mesh in enumerate(c3m.meshes):
            self._obj.write(f"mtllib {self.prefix}model.mtl\n")
            self._obj.write(f"o tile_{sub}_{mi}\n")
            for vtx in mesh.vertices:
                x = h.rotation[0] * vtx.x + h.rotation[1] * vtx.y + h.rotation[2] * vtx.z + h.translation[0]
                y = h.rotation[3] * vtx.x + h.rotation[4] * vtx.y + h.rotation[5] * vtx.z + h.translation[1]
                z = h.rotation[6] * vtx.x + h.rotation[7] * vtx.y + h.rotation[8] * vtx.z + h.translation[2]
                self._obj.write(f"v {x} {y} {z}\n")
                self._obj.write(f"vt {vtx.u} {vtx.v}\n")

            for gi, group in mesh.groups.items():
                self._obj.write(f"g g_{sub}_{gi}\n")
                self._obj.write(f"usemtl mtl_{sub}_{gi}\n")
                for face in group.faces:
                    a = face.a + 1 + self.vtx_count
                    b = face.b + 1 + self.vtx_count
                    c = face.c + 1 + self.vtx_count
                    self._obj.write(f"f {a}/{a} {b}/{b} {c}/{c}\n")
            self.vtx_count += len(mesh.vertices)
