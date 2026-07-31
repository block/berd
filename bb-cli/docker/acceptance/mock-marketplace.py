import argparse
import hashlib
import io
import json
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def artifact_bytes():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        entry = zipfile.ZipInfo("SKILL.md", (2024, 1, 1, 0, 0, 0))
        archive.writestr(entry, "---\nname: Docker Harness\n---\n# Docker Harness\n")
    return stream.getvalue()


ARTIFACT = artifact_bytes()
ARTIFACT_SHA = hashlib.sha256(ARTIFACT).hexdigest()
SKILL = {
    "slug": "docker-harness",
    "version_id": "docker-harness-v1",
    "content_sha256": ARTIFACT_SHA,
}


def plan(installed):
    action = "noop" if installed else "install"
    operation = {
        "action": action,
        "skill": SKILL,
        "artifact": None,
        "installed_via": "bundle:default",
    }
    if action == "install":
        operation["artifact"] = {
            "id": "docker-harness-v1",
            "download_url": "/v1/marketplace/artifacts/docker-harness-v1/download",
            "sha256": ARTIFACT_SHA,
            "size_bytes": len(ARTIFACT),
        }
    return {"plan_id": f"docker-harness-{action}", "operations": [operation], "warnings": []}


class Handler(BaseHTTPRequestHandler):
    expected_session_credential = None
    expected_playpen = None
    expected_service_path = None
    expected_bundle = None
    saw_expected_bundle = False

    def authenticate(self):
        if self.expected_session_credential and self.headers.get("X-Bb-Session-Credential") != self.expected_session_credential:
            self.send_error(401)
            return False
        if self.expected_playpen:
            baggage = self.headers.get("Baggage", "")
            if f"kgoose-builderbot-playpen={self.expected_playpen}" not in baggage:
                self.send_error(400)
                return False
        if self.expected_service_path and not self.path.startswith(f"{self.expected_service_path}/v1/marketplace/"):
            self.send_error(404)
            return False
        return True

    def do_GET(self):
        if not self.authenticate():
            return
        if self.path.endswith("/v1/marketplace/capabilities"):
            self.respond_json({"target_registry": {"agents": {"enabled": True, "global_paths": ["~/.agents/skills"], "project_paths": ["./.agents/skills"], "link_strategies": ["symlink"]}}})
        elif self.path.endswith("/v1/marketplace/skills/docker-harness"):
            self.respond_json({"slug": "docker-harness", "name": "Docker Harness", "description": "Deterministic acceptance fixture.", "status": "stable", "enabled": True, "latest_version_id": SKILL["version_id"], "latest_content_sha256": ARTIFACT_SHA, "source_id": "docker-acceptance", "source_revision": "fixture-v1", "latest_version": None})
        elif self.path.endswith("/v1/marketplace/artifacts/docker-harness-v1/download"):
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(ARTIFACT)))
            self.end_headers()
            self.wfile.write(ARTIFACT)
        else:
            self.send_error(404)

    def do_POST(self):
        if not self.authenticate():
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path.endswith("/v1/marketplace/install-plan"):
            if self.expected_bundle and not self.saw_expected_bundle:
                expected_target = {"type": "bundle", "slug": self.expected_bundle, "version_id": None}
                if expected_target not in payload.get("targets", []):
                    self.send_error(400, f"expected bundle target {self.expected_bundle}")
                    return
                Handler.saw_expected_bundle = True
            self.respond_json(plan(payload.get("installed", [])))
        else:
            self.send_error(404)

    def respond_json(self, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--expect-session-credential")
    parser.add_argument("--expect-playpen")
    parser.add_argument("--expect-service-path")
    parser.add_argument("--expect-bundle")
    args = parser.parse_args()
    Handler.expected_session_credential = args.expect_session_credential
    Handler.expected_playpen = args.expect_playpen
    Handler.expected_service_path = args.expect_service_path
    Handler.expected_bundle = args.expect_bundle
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
