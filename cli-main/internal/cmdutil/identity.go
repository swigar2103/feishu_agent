// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package cmdutil

import (
	"fmt"
	"io"

	"github.com/larksuite/cli/internal/core"
)

// AccessTokensToIdentities converts from_meta accessTokens (e.g. ["tenant", "user"])
// to CLI identity names (e.g. ["bot", "user"]).
func AccessTokensToIdentities(tokens []interface{}) []string {
	var identities []string
	for _, t := range tokens {
		if ts, ok := t.(string); ok {
			if ts == "tenant" {
				identities = append(identities, "bot")
			} else {
				identities = append(identities, ts)
			}
		}
	}
	return identities
}

// PrintIdentity outputs the current identity to stderr so callers (including AI agents)
// can see which identity is being used for the API call.
func PrintIdentity(w io.Writer, as core.Identity, config *core.CliConfig, autoDetected bool) {
	if as.IsBot() {
		if autoDetected {
			fmt.Fprintln(w, "[identity: bot (auto — not logged in; `auth login` for user identity)]")
		} else {
			fmt.Fprintln(w, "[identity: bot]")
		}
	} else if config != nil && config.UserOpenId != "" {
		fmt.Fprintf(w, "[identity: user (%s)]\n", config.UserOpenId)
	} else {
		fmt.Fprintln(w, "[identity: user]")
	}
}
