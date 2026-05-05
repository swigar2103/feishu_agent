// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package task

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"

	"github.com/larksuite/cli/shortcuts/common"
)

var ReminderTask = common.Shortcut{
	Service:     "task",
	Command:     "+reminder",
	Description: "manage task reminders",
	Risk:        "write",
	Scopes:      []string{"task:task:write"},
	AuthTypes:   []string{"user", "bot"},
	HasFormat:   true,

	Flags: []common.Flag{
		{Name: "task-id", Desc: "task id", Required: true},
		{Name: "set", Desc: "relative fire minutes to set (e.g. 15m, 1h, 1d)"},
		{Name: "remove", Type: "bool", Desc: "removes all existing reminders"},
	},

	Validate: func(ctx context.Context, runtime *common.RuntimeContext) error {
		if runtime.Str("set") == "" && !runtime.Bool("remove") {
			return WrapTaskError(ErrCodeTaskInvalidParams, "must specify either --set or --remove", "validate reminder")
		}
		if runtime.Str("set") != "" && runtime.Bool("remove") {
			return WrapTaskError(ErrCodeTaskInvalidParams, "cannot specify both --set and --remove", "validate reminder")
		}
		return nil
	},

	DryRun: func(ctx context.Context, runtime *common.RuntimeContext) *common.DryRunAPI {
		d := common.NewDryRunAPI()
		taskId := url.PathEscape(runtime.Str("task-id"))

		if runtime.Bool("remove") {
			d.Desc("1. GET task to find existing reminder IDs").
				GET("/open-apis/task/v2/tasks/" + taskId).
				Params(map[string]interface{}{"user_id_type": "open_id"}).
				Desc("2. POST to remove_reminders with found IDs")
		} else if setStr := runtime.Str("set"); setStr != "" {
			d.Desc("1. GET task to check existing reminders").
				GET("/open-apis/task/v2/tasks/" + taskId).
				Params(map[string]interface{}{"user_id_type": "open_id"}).
				Desc("2. POST to remove_reminders if any exist").
				Desc("3. POST to add_reminders").
				POST("/open-apis/task/v2/tasks/" + taskId + "/add_reminders")
		}

		return d
	},

	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		taskId := url.PathEscape(runtime.Str("task-id"))
		queryParams := make(larkcore.QueryParams)
		queryParams.Set("user_id_type", "open_id")

		// First, get the task to find existing reminders
		getResp, err := runtime.DoAPI(&larkcore.ApiReq{
			HttpMethod:  http.MethodGet,
			ApiPath:     "/open-apis/task/v2/tasks/" + taskId,
			QueryParams: queryParams,
		})

		var getResult map[string]interface{}
		if err == nil {
			if parseErr := json.Unmarshal(getResp.RawBody, &getResult); parseErr != nil {
				return WrapTaskError(ErrCodeTaskInternalError, fmt.Sprintf("failed to parse task details: %v", parseErr), "parse task details")
			}
		}

		data, err := HandleTaskApiResult(getResult, err, "get task reminders")
		if err != nil {
			return err
		}

		taskObj, _ := data["task"].(map[string]interface{})
		reminders, _ := taskObj["reminders"].([]interface{})

		if runtime.Bool("remove") {
			if len(reminders) == 0 {
				runtime.OutFormat(map[string]interface{}{"guid": taskId}, nil, func(w io.Writer) {
					fmt.Fprintln(w, "No existing reminders to remove.")
				})
				return nil
			}

			var reminderIds []string
			for _, r := range reminders {
				if rMap, ok := r.(map[string]interface{}); ok {
					if id, ok := rMap["id"].(string); ok {
						reminderIds = append(reminderIds, id)
					}
				}
			}

			if len(reminderIds) > 0 {
				body := map[string]interface{}{
					"reminder_ids": reminderIds,
				}
				apiResp, err := runtime.DoAPI(&larkcore.ApiReq{
					HttpMethod:  http.MethodPost,
					ApiPath:     "/open-apis/task/v2/tasks/" + taskId + "/remove_reminders",
					QueryParams: queryParams,
					Body:        body,
				})

				var removeResult map[string]interface{}
				if err == nil {
					if parseErr := json.Unmarshal(apiResp.RawBody, &removeResult); parseErr != nil {
						return WrapTaskError(ErrCodeTaskInternalError, fmt.Sprintf("failed to parse response: %v", parseErr), "parse remove response")
					}
				}

				if _, err := HandleTaskApiResult(removeResult, err, "remove task reminders"); err != nil {
					return err
				}
			}
		} else if setStr := runtime.Str("set"); setStr != "" {
			// Parse relative time string (e.g. 15m, 1h, 1d, or plain 30)
			var minutes int
			var parseErr error

			if strings.HasSuffix(setStr, "m") {
				minutes, parseErr = strconv.Atoi(strings.TrimSuffix(setStr, "m"))
			} else if strings.HasSuffix(setStr, "h") {
				h, e := strconv.Atoi(strings.TrimSuffix(setStr, "h"))
				if e == nil {
					minutes = h * 60
				}
				parseErr = e
			} else if strings.HasSuffix(setStr, "d") {
				d, e := strconv.Atoi(strings.TrimSuffix(setStr, "d"))
				if e == nil {
					minutes = d * 24 * 60
				}
				parseErr = e
			} else {
				// Default to minutes if no suffix
				minutes, parseErr = strconv.Atoi(setStr)
			}

			if parseErr != nil {
				return WrapTaskError(ErrCodeTaskInvalidParams, parseErr.Error(), "set reminder")
			}

			// If any reminders exist, remove them first
			if len(reminders) > 0 {
				var reminderIds []string
				for _, r := range reminders {
					if rMap, ok := r.(map[string]interface{}); ok {
						if id, ok := rMap["id"].(string); ok {
							reminderIds = append(reminderIds, id)
						}
					}
				}

				if len(reminderIds) > 0 {
					body := map[string]interface{}{
						"reminder_ids": reminderIds,
					}
					apiResp, err := runtime.DoAPI(&larkcore.ApiReq{
						HttpMethod:  http.MethodPost,
						ApiPath:     "/open-apis/task/v2/tasks/" + taskId + "/remove_reminders",
						QueryParams: queryParams,
						Body:        body,
					})

					var removeResult map[string]interface{}
					if err == nil {
						if parseErr := json.Unmarshal(apiResp.RawBody, &removeResult); parseErr != nil {
							return WrapTaskError(ErrCodeTaskInternalError, fmt.Sprintf("failed to parse response: %v", parseErr), "parse remove response")
						}
					}

					if _, err := HandleTaskApiResult(removeResult, err, "remove existing task reminders before setting new one"); err != nil {
						return err
					}
				}
			}

			body := map[string]interface{}{
				"reminders": []map[string]interface{}{
					{
						"relative_fire_minute": minutes,
					},
				},
			}
			apiResp, err := runtime.DoAPI(&larkcore.ApiReq{
				HttpMethod:  http.MethodPost,
				ApiPath:     "/open-apis/task/v2/tasks/" + taskId + "/add_reminders",
				QueryParams: queryParams,
				Body:        body,
			})

			var addResult map[string]interface{}
			if err == nil {
				if parseErr := json.Unmarshal(apiResp.RawBody, &addResult); parseErr != nil {
					return WrapTaskError(ErrCodeTaskInternalError, fmt.Sprintf("failed to parse response: %v", parseErr), "parse add response")
				}
			}

			if _, err := HandleTaskApiResult(addResult, err, "add task reminder"); err != nil {
				return err
			}
		}

		urlVal, _ := taskObj["url"].(string)
		urlVal = truncateTaskURL(urlVal)

		// Standardized write output: return resource identifiers
		outData := map[string]interface{}{
			"guid": taskId,
			"url":  urlVal,
		}

		runtime.OutFormat(outData, nil, func(w io.Writer) {
			fmt.Fprintf(w, "✅ Task reminders updated successfully!\n")
			fmt.Fprintf(w, "Task ID: %s\n", taskId)
			if urlVal != "" {
				fmt.Fprintf(w, "Task URL: %s\n", urlVal)
			}
		})
		return nil
	},
}
