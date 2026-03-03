#!/usr/bin/env python3
import json
import os
from tether_name import TetherClient


def fail(msg: str):
    print(json.dumps({"pass": False, "surface": "python", "error": msg}))
    raise SystemExit(1)


api_key = os.environ.get("TETHER_API_KEY")
agent_id = os.environ.get("LIFECYCLE_AGENT_ID")
key_path = os.environ.get("LIFECYCLE_PRIVATE_KEY_PATH")
suffix = os.environ.get("E2E_SUFFIX", "local")
verify_challenge = os.environ.get("PY_VERIFY_CHALLENGE")

if not api_key or not agent_id or not key_path or not verify_challenge:
    fail("Missing required env vars for Python surface")

mgmt = TetherClient(api_key=api_key)
signer = TetherClient(agent_id=agent_id, private_key_path=key_path)

temp_id = None
try:
    domains = mgmt.list_domains()

    created = mgmt.create_agent(f"e2e-py-{suffix}", "e2e python surface")
    temp_id = created.id

    proof = signer.sign(verify_challenge)
    verify = signer.submit_proof(verify_challenge, proof)

    keys = mgmt.list_agent_keys(agent_id)

    mgmt.delete_agent(temp_id)
    temp_id = None

    print(json.dumps({
        "pass": True,
        "surface": "python",
        "domainsCount": len(domains),
        "verifyOk": bool(verify.verified),
        "keysCount": len(keys),
        "createdAgentId": created.id,
    }))
except Exception as exc:
    fail(str(exc))
finally:
    if temp_id:
        try:
            mgmt.delete_agent(temp_id)
        except Exception:
            pass
    signer.close()
    mgmt.close()
