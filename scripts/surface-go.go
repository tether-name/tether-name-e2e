package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	tether "github.com/tether-name/tether-name-go"
)

type out struct {
	Pass          bool   `json:"pass"`
	Surface       string `json:"surface"`
	Error         string `json:"error,omitempty"`
	DomainsCount  int    `json:"domainsCount,omitempty"`
	RevokeOk      bool   `json:"revokeOk,omitempty"`
	RevokedKeyID  string `json:"revokedKeyId,omitempty"`
	KeysCount     int    `json:"keysCount,omitempty"`
	CreatedAgent  string `json:"createdAgentId,omitempty"`
}

func printAndExit(o out, code int) {
	b, _ := json.Marshal(o)
	fmt.Println(string(b))
	os.Exit(code)
}

func main() {
	apiKey := os.Getenv("TETHER_API_KEY")
	agentID := os.Getenv("LIFECYCLE_AGENT_ID")
	keyPath := os.Getenv("LIFECYCLE_PRIVATE_KEY_PATH")
	revokeChallenge := os.Getenv("GO_REVOKE_CHALLENGE")
	revokeKeyID := os.Getenv("GO_REVOKE_KEY_ID")
	suffix := os.Getenv("E2E_SUFFIX")

	if apiKey == "" || agentID == "" || keyPath == "" || revokeChallenge == "" || revokeKeyID == "" {
		printAndExit(out{Pass: false, Surface: "go", Error: "missing required env vars"}, 1)
	}

	ctx := context.Background()
	mgmt, err := tether.NewClient(tether.Options{ApiKey: apiKey})
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}
	signer, err := tether.NewClient(tether.Options{AgentID: agentID, PrivateKeyPath: keyPath})
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}

	tempID := ""
	defer func() {
		if tempID != "" {
			_, _ = mgmt.DeleteAgent(ctx, tempID)
		}
	}()

	domains, err := mgmt.ListDomains(ctx)
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}

	created, err := mgmt.CreateAgent(ctx, fmt.Sprintf("e2e-go-%s", suffix), "e2e go surface")
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}
	tempID = created.ID

	proof, err := signer.Sign(revokeChallenge)
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}

	rev, err := mgmt.RevokeAgentKey(ctx, agentID, revokeKeyID, tether.RevokeAgentKeyRequest{
		Reason:    "e2e_go_revoke",
		Challenge: revokeChallenge,
		Proof:     proof,
	})
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}

	keys, err := mgmt.ListAgentKeys(ctx, agentID)
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}

	_, err = mgmt.DeleteAgent(ctx, tempID)
	if err != nil {
		printAndExit(out{Pass: false, Surface: "go", Error: err.Error()}, 1)
	}
	tempID = ""

	printAndExit(out{
		Pass:         true,
		Surface:      "go",
		DomainsCount: len(domains),
		RevokeOk:     rev.Revoked,
		RevokedKeyID: revokeKeyID,
		KeysCount:    len(keys),
		CreatedAgent: created.ID,
	}, 0)
}
