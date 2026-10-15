"""A stand-in for api.x.com: a small OpenAPI spec (same operationIds, paths and
parameter names as X API v2 for the operations Ariana uses, plus a few she must
NOT be able to reach) and an HTTP server that records every request it gets.
Lets the real xmcp code run end to end with no network and no X account."""

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ME = {"id": "111", "name": "Ariana Reyes", "username": "ariana_reyes"}
USERS = {"someone": {"id": "222", "name": "Some One", "username": "someone",
                     "public_metrics": {"followers_count": 10, "following_count": 5, "tweet_count": 42}}}


def _op(op_id, params=None, body=None, tag="Posts"):
    op = {"operationId": op_id, "tags": [tag], "responses": {"200": {"description": "ok"}}}
    if params:
        op["parameters"] = params
    if body:
        op["requestBody"] = {"required": True, "content": {"application/json": {"schema": body}}}
    return op


def _path(name, ptype="string"):
    return {"name": name, "in": "path", "required": True, "schema": {"type": ptype}}


def spec():
    s = {"type": "string"}
    return {
        "openapi": "3.0.0",
        "info": {"title": "fake X", "version": "2"},
        "paths": {
            "/2/users/me": {"get": _op("getUsersMe", tag="Users")},
            "/2/users/by/username/{username}": {"get": _op(
                "getUsersByUsername", tag="Users",
                params=[_path("username"),
                        {"name": "user.fields", "in": "query", "required": False,
                         "explode": False, "schema": {"type": "array", "items": s}}])},
            "/2/tweets": {"post": _op("createPosts", body={"type": "object", "properties": {
                "text": s,
                "reply": {"type": "object", "properties": {"in_reply_to_tweet_id": s}}}})},
            "/2/tweets/{id}": {"delete": _op("deletePosts", params=[_path("id")])},
            "/2/tweets/search/recent": {"get": _op("searchPostsRecent", params=[
                {"name": "query", "in": "query", "required": True, "schema": s}])},
            "/2/users/{id}/likes": {"post": _op("likePost", tag="Users", params=[_path("id")],
                                                body={"type": "object", "properties": {"tweet_id": s}})},
            "/2/users/{id}/retweets": {"post": _op("repostPost", tag="Users", params=[_path("id")],
                                                   body={"type": "object", "properties": {"tweet_id": s}})},
            "/2/users/{id}/following": {"post": _op("followUser", tag="Users", params=[_path("id")],
                                                    body={"type": "object", "properties": {"target_user_id": s}})},
            "/2/users/{source_user_id}/following/{target_user_id}": {"delete": _op(
                "unfollowUser", tag="Users", params=[_path("source_user_id"), _path("target_user_id")])},
            "/2/dm_conversations/with/{participant_id}/messages": {"post": _op(
                "createDirectMessagesByParticipantId", tag="Direct Messages", params=[_path("participant_id")],
                body={"type": "object", "properties": {"text": s}})},
            "/2/users/{id}/dm/block": {"post": _op("blockUsersDms", tag="Users", params=[_path("id")])},
        },
    }


class FakeX:
    def __init__(self):
        self.requests = []  # (method, path, headers, parsed_body)
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, obj):
                data = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self):
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                path = self.path.split("?")[0]
                fake.requests.append((self.command, path, {k.lower(): v for k, v in self.headers.items()}, body))
                if not (self.headers.get("authorization") or "").startswith("OAuth "):
                    return self._send(401, {"title": "Unauthorized", "status": 401, "detail": "Unauthorized"})
                if (self.command, path) == ("GET", "/2/users/me"):
                    return self._send(200, {"data": ME})
                m = re.fullmatch(r"/2/users/by/username/([^/]+)", path)
                if m:
                    u = USERS.get(m.group(1).lower())
                    if not u:
                        return self._send(200, {"errors": [{"detail": f"Could not find user with username: [{m.group(1)}].",
                                                            "title": "Not Found Error", "type": "https://api.twitter.com/2/problems/resource-not-found"}]})
                    return self._send(200, {"data": u})
                if (self.command, path) == ("POST", "/2/tweets"):
                    text = (body or {}).get("text", "")
                    if text == "FORBIDDEN":
                        return self._send(403, {"title": "Forbidden", "status": 403, "detail": "You are not permitted to perform this action."})
                    if text == "RATELIMIT":
                        return self._send(429, {"title": "Too Many Requests", "status": 429, "detail": "Too Many Requests"})
                    return self._send(201, {"data": {"id": "1900000000000000001", "text": text}})
                if re.fullmatch(r"/2/users/\d+/likes", path):
                    return self._send(200, {"data": {"liked": True}})
                if re.fullmatch(r"/2/users/\d+/retweets", path):
                    return self._send(200, {"data": {"retweeted": True}})
                if re.fullmatch(r"/2/users/\d+/following", path):
                    return self._send(200, {"data": {"following": True, "pending_follow": False}})
                if self.command == "DELETE" and re.fullmatch(r"/2/users/\d+/following/\d+", path):
                    return self._send(200, {"data": {"following": False}})
                if re.fullmatch(r"/2/dm_conversations/with/\d+/messages", path):
                    return self._send(201, {"data": {"dm_conversation_id": "222-111", "dm_event_id": "9000"}})
                return self._send(404, {"title": "Not Found", "status": 404})

            do_GET = do_POST = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
