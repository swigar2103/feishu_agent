// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package base

import (
	"context"

	"github.com/larksuite/cli/shortcuts/common"
)

var BaseRecordDelete = common.Shortcut{
	Service:     "base",
	Command:     "+record-delete",
	Description: "Delete a record by ID",
	Risk:        "high-risk-write",
	Scopes:      []string{"base:record:delete"},
	AuthTypes:   authTypes(),
	Flags:       []common.Flag{baseTokenFlag(true), tableRefFlag(true), recordRefFlag(true)},
	DryRun:      dryRunRecordDelete,
	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		return executeRecordDelete(runtime)
	},
}
