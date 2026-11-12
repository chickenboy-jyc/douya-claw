# -*- coding: utf-8 -*-
# 微信小程序官方接口技能。
# 仅用标准库 urllib/json/base64，避免依赖 requests（运行环境可能未安装）。
import base64
import json
import urllib.parse
import urllib.request


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "agent-claw/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def _post_json(url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "agent-claw/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def _err(msg):
    return json.dumps({"ok": False, "error": msg}, ensure_ascii=False)


def _get_token(appid, secret):
    url = (
        "https://api.weixin.qq.com/cgi-bin/token?"
        "grant_type=client_credential&appid=%s&secret=%s"
        % (urllib.parse.quote(appid), urllib.parse.quote(secret))
    )
    try:
        return json.loads(_get(url).decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"_error": "获取 access_token 失败: %s" % e}


def main(params):
    action = (params.get("action") or "").strip()
    appid = (params.get("appid") or "").strip()
    secret = (params.get("secret") or "").strip()

    if not appid or not secret:
        return _err("未配置微信 AppID/AppSecret，请在设置里填")

    if action == "code2session":
        code = (params.get("code") or "").strip()
        if not code:
            return _err("code2session 需要 code 参数")
        url = (
            "https://api.weixin.qq.com/sns/jscode2session?"
            "appid=%s&secret=%s&js_code=%s&grant_type=authorization_code"
            % (
                urllib.parse.quote(appid),
                urllib.parse.quote(secret),
                urllib.parse.quote(code),
            )
        )
        try:
            return _get(url).decode("utf-8")
        except Exception as e:  # noqa: BLE001
            return _err("请求失败: %s" % e)

    if action == "get_access_token":
        try:
            return json.dumps(_get_token(appid, secret), ensure_ascii=False)
        except Exception as e:  # noqa: BLE001
            return _err("请求失败: %s" % e)

    if action == "send_subscribe_message":
        touser = (params.get("touser") or "").strip()
        template_id = (params.get("template_id") or "").strip()
        if not touser or not template_id:
            return _err("send_subscribe_message 需要 touser 和 template_id 参数")

        token_obj = _get_token(appid, secret)
        token = token_obj.get("access_token")
        if not token:
            return _err(json.dumps(token_obj, ensure_ascii=False))

        raw_data = (params.get("data") or "").strip() or "{}"
        try:
            data = json.loads(raw_data)
        except Exception:  # noqa: BLE001
            return _err("data 参数不是合法 JSON")
        if not isinstance(data, dict):
            return _err("data 参数必须是 JSON 对象")

        payload = {"touser": touser, "template_id": template_id, "data": data}
        page = (params.get("page") or "").strip()
        if page:
            payload["page"] = page
        try:
            return _post_json(
                "https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=%s"
                % token,
                payload,
            ).decode("utf-8")
        except Exception as e:  # noqa: BLE001
            return _err("请求失败: %s" % e)

    if action == "get_unlimited_qrcode":
        scene = (params.get("scene") or "").strip()
        page = (params.get("page") or "").strip()
        token_obj = _get_token(appid, secret)
        token = token_obj.get("access_token")
        if not token:
            return _err(json.dumps(token_obj, ensure_ascii=False))

        payload = {"scene": scene}
        if page:
            payload["page"] = page
        try:
            raw = _post_json(
                "https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=%s" % token,
                payload,
            )
            # 成功时微信返回二进制图片，失败时返回 JSON 错误对象。
            try:
                return json.dumps(json.loads(raw.decode("utf-8")), ensure_ascii=False)
            except Exception:  # noqa: BLE001
                b64 = base64.b64encode(raw).decode("ascii")
                return json.dumps(
                    {"ok": True, "format": "png", "size": len(raw), "base64": b64},
                    ensure_ascii=False,
                )
        except Exception as e:  # noqa: BLE001
            return _err("请求失败: %s" % e)

    return _err(
        "未知 action: %s（可选 code2session / get_access_token / "
        "send_subscribe_message / get_unlimited_qrcode）" % action
    )
