const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 서버 보관 24시간

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;    // 이미지 10MB 제한



export default {

  async fetch(request, env) {

    try {

      // 브라우저 CORS preflight

      if (request.method === "OPTIONS") {

        return new Response(null, {

          status: 204,

          headers: corsHeaders(),

        });

      }



      const url = new URL(request.url);

      const path = url.pathname.replace(/\/+$/, "") || "/";

      const parts = path.split("/").filter(Boolean);



      // ─────────────────────────────

      // MCP /mcp

      // ChatGPT plugin tools

      // ─────────────────────────────

      if (path === "/mcp") {

        if (request.method !== "POST") {

          return json({ ok: false, error: "Method not allowed" }, 405);

        }

        return await handleMcp(request, env);

      }



      // ─────────────────────────────

      // GET /

      // 서버 살아있는지 확인

      // ─────────────────────────────

      if (request.method === "GET" && path === "/") {

        return json({

          ok: true,

          service: "ZETA Snapshot Relay",

          version: 3,

          mcp: "/mcp",

        });

      }



      // ─────────────────────────────

      // POST /snapshots

      // 새 스냅샷 요청 생성

      // ─────────────────────────────

      if (

        request.method === "POST" &&

        parts.length === 1 &&

        parts[0] === "snapshots"

      ) {

        return await createSnapshot(request, env);

      }



      if (parts[0] === "snapshots" && parts.length >= 2) {

        const token = parts[1];



        // GET /snapshots/:token

        if (request.method === "GET" && parts.length === 2) {

          return await getSnapshot(request, env, token);

        }



        // GET /snapshots/:token/status

        if (

          request.method === "GET" &&

          parts.length === 3 &&

          parts[2] === "status"

        ) {

          return await getStatus(env, token);

        }



        // PATCH /snapshots/:token/status

        if (

          request.method === "PATCH" &&

          parts.length === 3 &&

          parts[2] === "status"

        ) {

          return await updateStatus(request, env, token);

        }



        // PUT /snapshots/:token/character-image

        if (

          request.method === "PUT" &&

          parts.length === 3 &&

          parts[2] === "character-image"

        ) {

          return await uploadImage(

            request,

            env,

            token,

            "character"

          );

        }



        // GET /snapshots/:token/character-image

        if (

          request.method === "GET" &&

          parts.length === 3 &&

          parts[2] === "character-image"

        ) {

          return await getImage(env, token, "character");

        }



        // PUT /snapshots/:token/user-image

        if (

          request.method === "PUT" &&

          parts.length === 3 &&

          parts[2] === "user-image"

        ) {

          return await uploadImage(

            request,

            env,

            token,

            "user"

          );

        }



        // GET /snapshots/:token/user-image

        if (

          request.method === "GET" &&

          parts.length === 3 &&

          parts[2] === "user-image"

        ) {

          return await getImage(env, token, "user");

        }



        // POST 또는 PUT /snapshots/:token/result

        if (

          (request.method === "POST" || request.method === "PUT") &&

          parts.length === 3 &&

          parts[2] === "result"

        ) {

          return await uploadImage(

            request,

            env,

            token,

            "result"

          );

        }



        // GET /snapshots/:token/image

        if (

          request.method === "GET" &&

          parts.length === 3 &&

          parts[2] === "image"

        ) {

          return await getImage(env, token, "result");

        }



        // DELETE /snapshots/:token

        if (request.method === "DELETE" && parts.length === 2) {

          return await deleteSnapshot(env, token);

        }

      }



      return json(

        {

          ok: false,

          error: "Not found",

        },

        404

      );

    } catch (error) {

      console.error(error);



      return json(

        {

          ok: false,

          error: "Internal server error",

          detail: String(error?.message || error),

        },

        500

      );

    }

  },

};





// ─────────────────────────────────

// 새 요청 만들기

// ─────────────────────────────────



async function createSnapshot(request, env) {

  const contentType = request.headers.get("content-type") || "";



  if (!contentType.includes("application/json")) {

    return json(

      {

        ok: false,

        error: "Content-Type must be application/json",

      },

      415

    );

  }



  let data;



  try {

    data = await request.json();

  } catch {

    return json(

      {

        ok: false,

        error: "Invalid JSON",

      },

      400

    );

  }



  const clientId = String(data.clientId || "").trim();

  const roomId = String(data.roomId || "").trim();



  if (!clientId) {

    return json(

      {

        ok: false,

        error: "clientId is required",

      },

      400

    );

  }



  if (!roomId) {

    return json(

      {

        ok: false,

        error: "roomId is required",

      },

      400

    );

  }



  const id = crypto.randomUUID();

  const token = randomToken();



  const now = Date.now();

  const expiresAt = now + SNAPSHOT_TTL_MS;



  const anchor = data.anchor || {};



  await env.DB.prepare(`

    INSERT INTO snapshots (

      id,

      token,

      client_id,

      room_id,



      anchor_message_id,

      anchor_hash,

      anchor_preview,



      messages_json,

      character_json,

      user_profile_json,



      status,



      created_at,

      updated_at,

      expires_at

    )



    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

  `)

    .bind(

      id,

      token,

      clientId,

      roomId,



      anchor.messageId || null,

      anchor.hash || null,

      anchor.preview || null,



      JSON.stringify(data.messages || []),

      JSON.stringify(data.character || null),

      JSON.stringify(data.userProfile || null),



      "pending",



      now,

      now,

      expiresAt

    )

    .run();



  return json(

    {

      ok: true,



      snapshot: {

        id,

        token,

        status: "pending",

        expiresAt,

      },

    },

    201

  );

}





// ─────────────────────────────────

// 요청 정보 읽기

// ChatGPT 쪽에서 이걸 읽게 됨

// ─────────────────────────────────



async function getSnapshot(request, env, token) {

  const row = await findSnapshot(env, token);



  if (!row) {

    return json(

      {

        ok: false,

        error: "Snapshot not found",

      },

      404

    );

  }



  if (isExpired(row)) {

    return json(

      {

        ok: false,

        error: "Snapshot expired",

      },

      410

    );

  }



  const base = new URL(request.url).origin;



  return json({

    ok: true,



    snapshot: {

      id: row.id,



      clientId: row.client_id,

      roomId: row.room_id,



      anchor: {

        messageId: row.anchor_message_id,

        hash: row.anchor_hash,

        preview: row.anchor_preview,

      },



      messages: safeJson(row.messages_json, []),

      character: safeJson(row.character_json, null),

      userProfile: safeJson(row.user_profile_json, null),



      characterImageUrl:

        row.character_image_key

          ? `${base}/snapshots/${encodeURIComponent(token)}/character-image`

          : null,



      userImageUrl:

        row.user_image_key

          ? `${base}/snapshots/${encodeURIComponent(token)}/user-image`

          : null,



      resultImageUrl:

        row.result_image_key

          ? `${base}/snapshots/${encodeURIComponent(token)}/image`

          : null,



      status: row.status,

      error: row.error_message,



      createdAt: row.created_at,

      updatedAt: row.updated_at,

      expiresAt: row.expires_at,

    },

  });

}





// ─────────────────────────────────

// 상태 읽기

// 제타가 생성 완료됐는지 확인

// ─────────────────────────────────



async function getStatus(env, token) {

  const row = await findSnapshot(env, token);



  if (!row) {

    return json(

      {

        ok: false,

        error: "Snapshot not found",

      },

      404

    );

  }



  if (isExpired(row)) {

    return json(

      {

        ok: false,

        error: "Snapshot expired",

      },

      410

    );

  }



  return json({

    ok: true,



    id: row.id,

    status: row.status,

    hasResult: Boolean(row.result_image_key),



    error: row.error_message || null,



    updatedAt: row.updated_at,

    expiresAt: row.expires_at,

  });

}





// ─────────────────────────────────

// 상태 변경

// pending → processing / failed

// ─────────────────────────────────



async function updateStatus(request, env, token) {

  const row = await findSnapshot(env, token);



  if (!row) {

    return json(

      {

        ok: false,

        error: "Snapshot not found",

      },

      404

    );

  }



  let data;



  try {

    data = await request.json();

  } catch {

    return json(

      {

        ok: false,

        error: "Invalid JSON",

      },

      400

    );

  }



  const allowed = new Set([

    "pending",

    "processing",

    "failed",

  ]);



  if (!allowed.has(data.status)) {

    return json(

      {

        ok: false,

        error: "Invalid status",

      },

      400

    );

  }



  const now = Date.now();



  await env.DB.prepare(`

    UPDATE snapshots

    SET

      status = ?,

      error_message = ?,

      updated_at = ?

    WHERE token = ?

  `)

    .bind(

      data.status,

      data.error || null,

      now,

      token

    )

    .run();



  return json({

    ok: true,

    status: data.status,

  });

}





// ─────────────────────────────────

// 이미지 업로드

// character / user / result

// ─────────────────────────────────



async function uploadImage(request, env, token, type) {

  const row = await findSnapshot(env, token);



  if (!row) {

    return json(

      {

        ok: false,

        error: "Snapshot not found",

      },

      404

    );

  }



  if (isExpired(row)) {

    return json(

      {

        ok: false,

        error: "Snapshot expired",

      },

      410

    );

  }



  const mime =

    (request.headers.get("content-type") || "")

      .split(";")[0]

      .trim()

      .toLowerCase();



  const allowed = new Set([

    "image/png",

    "image/jpeg",

    "image/webp",

    "image/gif",

  ]);



  if (!allowed.has(mime)) {

    return json(

      {

        ok: false,

        error: "Only PNG, JPEG, WEBP and GIF are allowed",

      },

      415

    );

  }



  const bytes = await request.arrayBuffer();



  if (bytes.byteLength > MAX_IMAGE_BYTES) {

    return json(

      {

        ok: false,

        error: "Image exceeds 10 MB",

      },

      413

    );

  }



  const extension = extensionFromMime(mime);



  const key =

    `snapshots/${row.id}/${type}-${crypto.randomUUID()}.${extension}`;



  const oldKey =

    type === "character"

      ? row.character_image_key

      : type === "user"

        ? row.user_image_key

        : row.result_image_key;



  await env.IMAGES.put(key, bytes, {

    httpMetadata: {

      contentType: mime,

    },

  });



  // 새 이미지가 정상적으로 올라간 뒤 이전 파일 삭제

  if (oldKey) {

    try {

      await env.IMAGES.delete(oldKey);

    } catch (e) {

      console.warn("Could not delete old image:", e);

    }

  }



  const now = Date.now();



  if (type === "character") {

    await env.DB.prepare(`

      UPDATE snapshots

      SET

        character_image_key = ?,

        updated_at = ?

      WHERE token = ?

    `)

      .bind(key, now, token)

      .run();

  }



  if (type === "user") {

    await env.DB.prepare(`

      UPDATE snapshots

      SET

        user_image_key = ?,

        updated_at = ?

      WHERE token = ?

    `)

      .bind(key, now, token)

      .run();

  }



  if (type === "result") {

    await env.DB.prepare(`

      UPDATE snapshots

      SET

        result_image_key = ?,

        result_mime = ?,

        status = 'completed',

        error_message = NULL,

        updated_at = ?

      WHERE token = ?

    `)

      .bind(

        key,

        mime,

        now,

        token

      )

      .run();

  }



  return json({

    ok: true,

    type,

    status:

      type === "result"

        ? "completed"

        : row.status,

  });

}





// ─────────────────────────────────

// R2 이미지 읽기

// ─────────────────────────────────



async function getImage(env, token, type) {

  const row = await findSnapshot(env, token);



  if (!row) {

    return json(

      {

        ok: false,

        error: "Snapshot not found",

      },

      404

    );

  }



  if (isExpired(row)) {

    return json(

      {

        ok: false,

        error: "Snapshot expired",

      },

      410

    );

  }



  const key =

    type === "character"

      ? row.character_image_key

      : type === "user"

        ? row.user_image_key

        : row.result_image_key;



  if (!key) {

    return json(

      {

        ok: false,

        error: "Image not found",

      },

      404

    );

  }



  const object = await env.IMAGES.get(key);



  if (!object) {

    return json(

      {

        ok: false,

        error: "Image not found in storage",

      },

      404

    );

  }



  const headers = new Headers(corsHeaders());



  object.writeHttpMetadata(headers);



  headers.set("etag", object.httpEtag);

  headers.set("Cache-Control", "private, max-age=300");



  return new Response(object.body, {

    status: 200,

    headers,

  });

}





// ─────────────────────────────────

// 요청 삭제

// D1 + R2 같이 지움

// ─────────────────────────────────



async function deleteSnapshot(env, token) {

  const row = await findSnapshot(env, token);



  if (!row) {

    return json(

      {

        ok: false,

        error: "Snapshot not found",

      },

      404

    );

  }



  const keys = [

    row.character_image_key,

    row.user_image_key,

    row.result_image_key,

  ].filter(Boolean);



  if (keys.length) {

    await Promise.all(

      keys.map((key) =>

        env.IMAGES.delete(key).catch(() => null)

      )

    );

  }



  await env.DB.prepare(`

    DELETE FROM snapshots

    WHERE token = ?

  `)

    .bind(token)

    .run();



  return json({

    ok: true,

    deleted: true,

  });

}





// ─────────────────────────────────
// MCP server for ChatGPT plugin
// ─────────────────────────────────

const MCP_ORIGIN = "https://zeta-snapshot.softbridge.workers.dev";

async function handleMcp(request, env) {
  let rpc;
  try { rpc = await request.json(); }
  catch { return mcpError(null, -32700, "Parse error"); }

  if (!rpc || rpc.jsonrpc !== "2.0") {
    return mcpError(rpc?.id ?? null, -32600, "Invalid Request");
  }

  const id = rpc.id ?? null;

  if (rpc.method === "initialize") {
    return mcpOk(id, {
      protocolVersion: rpc.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "zeta-snapshot", version: "3.1.2" },
      instructions: "Read snapshots with get_snapshot. After generating an image, save it with save_snapshot_result using the same token and generated image file."
    });
  }

  if (rpc.method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (rpc.method === "ping") return mcpOk(id, {});
  if (rpc.method === "tools/list") return mcpOk(id, { tools: getMcpTools() });

  if (rpc.method === "tools/call") {
    try {
      return mcpOk(id, await callMcpTool(env, rpc.params?.name, rpc.params?.arguments || {}));
    } catch (error) {
      const message = String(error?.message || error);
      return mcpOk(id, {
        content: [{ type: "text", text: message }],
        structuredContent: { ok: false, error: message },
        isError: true
      });
    }
  }

  return mcpError(id, -32601, "Method not found");
}

function getMcpTools() {
  const tokenSchema = {
    type: "object",
    properties: { token: { type: "string", minLength: 1 } },
    required: ["token"],
    additionalProperties: false
  };

  const openAiFileSchema = {
    type: "object",
    properties: {
      download_url: { type: "string" },
      file_id: { type: "string" },
      mime_type: { type: "string" },
      file_name: { type: "string" }
    },
    required: ["download_url", "file_id"],
    additionalProperties: false
  };

  return [
    {
      name: "get_snapshot",
      title: "Get ZETA snapshot",
      description: "Load one ZETA snapshot by token, including characters, user profile, messages, style settings, and stored image URLs.",
      inputSchema: tokenSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    {
      name: "get_snapshot_status",
      title: "Get ZETA snapshot status",
      description: "Read the current processing status and generated result URL for one ZETA snapshot.",
      inputSchema: tokenSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    {
      name: "get_snapshot_reference_images",
      title: "Get ZETA snapshot reference images",
      description: "Return every included character reference image plus the stored user reference image for image generation.",
      inputSchema: tokenSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    {
      name: "save_snapshot_result",
      title: "Save generated ZETA snapshot image",
      description: "Persist a generated image to the same ZETA snapshot so the ZETA client can display it automatically.",
      inputSchema: {
        type: "object",
        $defs: { OpenAIFile: openAiFileSchema },
        properties: {
          token: { type: "string", minLength: 1 },
          image: { $ref: "#/$defs/OpenAIFile" }
        },
        required: ["token", "image"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      _meta: {
        "openai/fileParams": ["image"],
        "openai/toolInvocation/invoking": "ZETA에 생성 이미지를 저장하는 중",
        "openai/toolInvocation/invoked": "ZETA에 생성 이미지를 저장했어요"
      }
    }
  ];
}

async function callMcpTool(env, name, args) {
  if (name === "get_snapshot") return mcpGetSnapshot(env, args);
  if (name === "get_snapshot_status") return mcpGetSnapshotStatus(env, args);
  if (name === "get_snapshot_reference_images") return mcpGetSnapshotReferenceImages(env, args);
  if (name === "save_snapshot_result") return mcpSaveSnapshotResult(env, args);
  throw new Error("Unknown tool: " + name);
}

function requireMcpToken(args) {
  const token = String(args?.token || "").trim();
  if (!token) throw new Error("token is required");
  return token;
}

function buildMcpSnapshot(row, token) {
  const character = safeJson(row.character_json, null);
  const userProfile = safeJson(row.user_profile_json, null);
  const snapshotOptions = character && typeof character === "object"
    ? character.snapshotOptions || {}
    : {};

  return {
    id: row.id,
    token,
    clientId: row.client_id,
    roomId: row.room_id,
    anchor: {
      messageId: row.anchor_message_id,
      hash: row.anchor_hash,
      preview: row.anchor_preview
    },
    messages: safeJson(row.messages_json, []),
    character,
    userProfile,
    stylePreset: snapshotOptions.stylePreset || null,
    stylePrompt: snapshotOptions.stylePrompt || null,
    additionalInstructions: snapshotOptions.additionalInstructions || null,
    characterImageUrl: row.character_image_key
      ? MCP_ORIGIN + "/snapshots/" + encodeURIComponent(token) + "/character-image"
      : null,
    userImageUrl: row.user_image_key
      ? MCP_ORIGIN + "/snapshots/" + encodeURIComponent(token) + "/user-image"
      : null,
    resultImageUrl: row.result_image_key
      ? MCP_ORIGIN + "/snapshots/" + encodeURIComponent(token) + "/image"
      : null,
    status: row.status,
    error: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

async function mcpGetSnapshot(env, args) {
  const token = requireMcpToken(args);
  const row = await findSnapshotWithRetry(env, token);
  if (!row) throw new Error("Snapshot not found");
  if (isExpired(row)) throw new Error("Snapshot expired");
  const snapshot = buildMcpSnapshot(row, token);
  return {
    content: [{ type: "text", text: JSON.stringify(snapshot) }],
    structuredContent: snapshot,
    isError: false
  };
}

async function mcpGetSnapshotStatus(env, args) {
  const token = requireMcpToken(args);
  const row = await findSnapshotWithRetry(env, token);
  if (!row) throw new Error("Snapshot not found");
  if (isExpired(row)) throw new Error("Snapshot expired");

  const status = {
    token,
    status: row.status,
    error: row.error_message || null,
    resultImageUrl: row.result_image_key
      ? MCP_ORIGIN + "/snapshots/" + encodeURIComponent(token) + "/image"
      : null,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };

  return {
    content: [{ type: "text", text: JSON.stringify(status) }],
    structuredContent: status,
    isError: false
  };
}

async function fetchAllowedSnapshotReference(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;

  let parsed;
  try { parsed = new URL(raw); }
  catch { return null; }

  if (parsed.protocol !== "https:" || parsed.hostname !== "image.zeta-ai.io") {
    return null;
  }

  const response = await fetch(parsed.toString(), { redirect: "follow" });
  if (!response.ok) return null;

  let finalUrl;
  try { finalUrl = new URL(response.url || parsed.toString()); }
  catch { return null; }

  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "image.zeta-ai.io") {
    return null;
  }

  const mimeType = (response.headers.get("content-type") || "image/png")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(mimeType)) {
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return null;

  return { bytes, mimeType };
}

async function readStoredSnapshotReference(env, key) {
  if (!key) return null;
  const object = await env.IMAGES.get(key);
  if (!object) return null;

  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return null;

  const mimeType = object.httpMetadata?.contentType || "image/png";
  return { bytes, mimeType };
}

async function mcpGetSnapshotReferenceImages(env, args) {
  const token = requireMcpToken(args);
  const row = await findSnapshotWithRetry(env, token);
  if (!row) throw new Error("Snapshot not found");
  if (isExpired(row)) throw new Error("Snapshot expired");

  const content = [];
  const references = [];
  const character = safeJson(row.character_json, null);

  const includedCharacters = Array.isArray(character?.characters)
    ? character.characters
        .filter(item => item && item.included === true)
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
    : [];

  let characterReferenceCount = 0;
  const seenUrls = new Set();

  for (const item of includedCharacters) {
    const imageUrl = String(item?.imageUrl || "").trim();
    if (!imageUrl || seenUrls.has(imageUrl)) continue;
    seenUrls.add(imageUrl);

    try {
      const image = await fetchAllowedSnapshotReference(imageUrl);
      if (!image) continue;

      content.push({
        type: "image",
        data: bytesToBase64(image.bytes),
        mimeType: image.mimeType
      });

      references.push({
        kind: "character",
        id: item.id || item.slotId || null,
        name: item.name || null,
        primary: item.primary === true,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.byteLength,
        source: "character-profile"
      });
      characterReferenceCount += 1;
    } catch {}
  }

  // Backward-compatible fallback for old snapshots or inaccessible original URLs.
  if (!characterReferenceCount && row.character_image_key) {
    const image = await readStoredSnapshotReference(env, row.character_image_key);
    if (image) {
      content.push({
        type: "image",
        data: bytesToBase64(image.bytes),
        mimeType: image.mimeType
      });
      references.push({
        kind: "character",
        id: character?.id || null,
        name: character?.name || null,
        primary: true,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.byteLength,
        source: "stored-fallback"
      });
    }
  }

  if (row.user_image_key) {
    const image = await readStoredSnapshotReference(env, row.user_image_key);
    if (image) {
      content.push({
        type: "image",
        data: bytesToBase64(image.bytes),
        mimeType: image.mimeType
      });
      references.push({
        kind: "user",
        id: safeJson(row.user_profile_json, null)?.id || null,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.byteLength,
        source: "stored-user-profile"
      });
    }
  }

  if (!content.length) {
    content.push({ type: "text", text: "No stored reference images" });
  }

  return {
    content,
    structuredContent: {
      ok: true,
      includedCharacterCount: includedCharacters.length,
      characterReferenceCount,
      references
    },
    isError: false
  };
}

async function mcpSaveSnapshotResult(env, args) {
  const token = requireMcpToken(args);
  const image = args?.image;

  if (!image || typeof image !== "object") {
    throw new Error("image file is required");
  }

  const downloadUrl = String(image.download_url || "").trim();
  if (!downloadUrl) throw new Error("image.download_url is required");

  let parsedUrl;
  try { parsedUrl = new URL(downloadUrl); }
  catch { throw new Error("Invalid image download URL"); }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Image download URL must use HTTPS");
  }

  const row = await findSnapshotWithRetry(env, token);
  if (!row) throw new Error("Snapshot not found");
  if (isExpired(row)) throw new Error("Snapshot expired");

  const response = await fetch(downloadUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error("Could not download generated image (" + response.status + ")");
  }

  const headerMime = (response.headers.get("content-type") || "")
    .split(";")[0].trim().toLowerCase();
  const declaredMime = String(image.mime_type || "")
    .split(";")[0].trim().toLowerCase();
  const mime = declaredMime || headerMime;

  if (!new Set(["image/png","image/jpeg","image/webp","image/gif"]).has(mime)) {
    throw new Error("Generated file is not a supported image type");
  }

  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Generated image is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Generated image exceeds 10 MB");
  }

  const uploadRequest = new Request(
    MCP_ORIGIN + "/snapshots/" + encodeURIComponent(token) + "/result",
    {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: bytes
    }
  );

  const uploadResponse = await uploadImage(uploadRequest, env, token, "result");
  const uploadResult = await uploadResponse.json();

  if (!uploadResponse.ok || !uploadResult?.ok) {
    throw new Error(uploadResult?.error || "Could not save generated image");
  }

  const result = {
    ok: true,
    token,
    status: "completed",
    resultImageUrl: MCP_ORIGIN + "/snapshots/" + encodeURIComponent(token) + "/image",
    fileId: image.file_id || null
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function mcpOk(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function mcpError(id, code, message) {
  return json({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}


// ─────────────────────────────────

// DB helper

// ─────────────────────────────────



async function findSnapshot(env, token) {

  return await env.DB.prepare(`

    SELECT *

    FROM snapshots

    WHERE token = ?

    LIMIT 1

  `)

    .bind(token)

    .first();

}

async function findSnapshotWithRetry(env, token, attempts = 6) {
  const delays = [0, 120, 250, 500, 900, 1500];

  for (let index = 0; index < attempts; index += 1) {
    const delay = delays[Math.min(index, delays.length - 1)] || 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));

    const row = await findSnapshot(env, token);
    if (row) return row;
  }

  return null;
}





// ─────────────────────────────────

// Utils

// ─────────────────────────────────



function isExpired(row) {

  return Number(row.expires_at) <= Date.now();

}





function safeJson(value, fallback) {

  if (!value) return fallback;



  try {

    return JSON.parse(value);

  } catch {

    return fallback;

  }

}





function extensionFromMime(mime) {

  switch (mime) {

    case "image/png":

      return "png";



    case "image/jpeg":

      return "jpg";



    case "image/webp":

      return "webp";



    case "image/gif":

      return "gif";



    default:

      return "bin";

  }

}





function randomToken(byteLength = 32) {

  const bytes = new Uint8Array(byteLength);



  crypto.getRandomValues(bytes);



  let binary = "";



  for (const byte of bytes) {

    binary += String.fromCharCode(byte);

  }



  return btoa(binary)

    .replace(/\+/g, "-")

    .replace(/\//g, "_")

    .replace(/=+$/g, "");

}





function corsHeaders() {

  return {

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":

      "GET, POST, PUT, PATCH, DELETE, OPTIONS",

    "Access-Control-Allow-Headers":

      "Content-Type",

    "Access-Control-Max-Age": "86400",

  };

}





function json(data, status = 200) {

  return new Response(

    JSON.stringify(data, null, 2),

    {

      status,



      headers: {

        ...corsHeaders(),



        "Content-Type":

          "application/json; charset=utf-8",



        "Cache-Control":

          "no-store",

      },

    }

  );

}