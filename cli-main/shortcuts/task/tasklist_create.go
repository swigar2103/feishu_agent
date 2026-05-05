// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package task

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"

	"github.com/larksuite/cli/shortcuts/common"
)

var CreateTasklist = common.Shortcut{
	Service:     "task",
	Command:     "+tasklist-create",
	Description: "create a tasklist and optionally add tasks",
	Risk:        "write",
	Scopes:      []string{"task:tasklist:write", "task:task:write"},
	AuthTypes:   []string{"user", "bot"},
	HasFormat:   true,

	Flags: []common.Flag{
		{Name: "name", Desc: "tasklist name", Required: true},
		{Name: "member", Desc: "comma-separated open_ids to add as editors"},
		{Name: "data", Desc: "JSON array of tasks to create within this tasklist"},
	},

	DryRun: func(ctx context.Context, runtime *common.RuntimeContext) *common.DryRunAPI {
		body := buildTasklistCreateBody(runtime)

		d := common.NewDryRunAPI().
			Desc("1. Create Tasklist").
			POST("/open-apis/task/v2/tasklists").
			Params(map[string]interface{}{"user_id_type": "open_id"}).
			Body(body)

		if dataStr := runtime.Str("data"); dataStr != "" {
			d.Desc("2. Create Tasks within the new tasklist (concurrently)")
		}

		return d
	},

	Execute: func(ctx context.Context, runtime *common.RuntimeContext) error {
		body := buildTasklistCreateBody(runtime)
		queryParams := make(larkcore.QueryParams)
		queryParams.Set("user_id_type", "open_id")

		apiResp, err := runtime.DoAPI(&larkcore.ApiReq{
			HttpMethod:  http.MethodPost,
			ApiPath:     "/open-apis/task/v2/tasklists",
			QueryParams: queryParams,
			Body:        body,
		})

		var result map[string]interface{}
		if err == nil {
			if parseErr := json.Unmarshal(apiResp.RawBody, &result); parseErr != nil {
				return WrapTaskError(ErrCodeTaskInternalError, fmt.Sprintf("failed to parse response: %v", parseErr), "parse create tasklist")
			}
		}

		data, err := HandleTaskApiResult(result, err, "create tasklist")
		if err != nil {
			return err
		}

		tasklist, _ := data["tasklist"].(map[string]interface{})
		tasklistGuid, _ := tasklist["guid"].(string)
		tasklistName, _ := tasklist["name"].(string)
		tasklistUrl, _ := tasklist["url"].(string)
		tasklistUrl = truncateTaskURL(tasklistUrl)

		// Create tasks if data is provided
		var tasks []map[string]interface{}
		var createdTasks []map[string]interface{}
		var failedTasks []string

		if dataStr := runtime.Str("data"); dataStr != "" {
			if err := json.Unmarshal([]byte(dataStr), &tasks); err != nil {
				return WrapTaskError(ErrCodeTaskInvalidParams, fmt.Sprintf("failed to parse --data as JSON array: %v", err), "parse data")
			}

			var wg sync.WaitGroup
			var mu sync.Mutex

			for i, taskDef := range tasks {
				wg.Add(1)
				go func(idx int, tDef map[string]interface{}) {
					defer func() {
						if r := recover(); r != nil {
							fmt.Fprintf(runtime.IO().ErrOut, "recovered in defer: %v\n", r)
						}
						wg.Done()
					}()

					// Add tasklist_guid to the task definition
					tDef["tasklists"] = []map[string]interface{}{
						{
							"tasklist_guid": tasklistGuid,
						},
					}

					// If assignee is provided as string, convert it to members
					if assignee, ok := tDef["assignee"].(string); ok {
						tDef["members"] = []map[string]interface{}{
							{
								"id":   assignee,
								"role": "assignee",
								"type": "user",
							},
						}
						delete(tDef, "assignee")
					}

					tResp, tErr := runtime.DoAPI(&larkcore.ApiReq{
						HttpMethod:  http.MethodPost,
						ApiPath:     "/open-apis/task/v2/tasks",
						QueryParams: queryParams,
						Body:        tDef,
					})

					mu.Lock()
					defer mu.Unlock()

					var tResult map[string]interface{}
					if tErr == nil {
						if json.Unmarshal(tResp.RawBody, &tResult) != nil {
							tErr = WrapTaskError(ErrCodeTaskInternalError, "failed to parse task response", "parse task")
						}
					}

					tData, tErr := HandleTaskApiResult(tResult, tErr, "create task in tasklist")
					if tErr != nil {
						summary, _ := tDef["summary"].(string)
						failedTasks = append(failedTasks, fmt.Sprintf("Index %d (%s): %v", idx, summary, tErr))
						return
					}

					if t, ok := tData["task"].(map[string]interface{}); ok {
						guid, _ := t["guid"].(string)
						urlVal, _ := t["url"].(string)
						urlVal = truncateTaskURL(urlVal)
						createdTasks = append(createdTasks, map[string]interface{}{
							"guid": guid,
							"url":  urlVal,
						})
					}
				}(i, taskDef)
			}
			wg.Wait()
		}

		// Standardized write output: return resource identifiers
		outData := map[string]interface{}{
			"guid":          tasklistGuid,
			"url":           tasklistUrl,
			"created_tasks": createdTasks,
		}

		runtime.OutFormat(outData, nil, func(w io.Writer) {
			fmt.Fprintf(w, "✅ Tasklist created successfully!\n")
			fmt.Fprintf(w, "Tasklist Name: %s\n", tasklistName)
			fmt.Fprintf(w, "Tasklist ID: %s\n", tasklistGuid)
			if tasklistUrl != "" {
				fmt.Fprintf(w, "Tasklist URL: %s\n", tasklistUrl)
			}

			if len(tasks) > 0 {
				fmt.Fprintln(w, strings.Repeat("-", 20))
				fmt.Fprintf(w, "Tasks created: %d/%d\n", len(createdTasks), len(tasks))
				for _, t := range createdTasks {
					guid, _ := t["guid"].(string)
					urlVal, _ := t["url"].(string)
					fmt.Fprintf(w, "  - ID: %s", guid)
					if urlVal != "" {
						fmt.Fprintf(w, ", URL: %s", urlVal)
					}
					fmt.Fprintln(w)
				}
				if len(failedTasks) > 0 {
					fmt.Fprintf(w, "\nFailed tasks:\n")
					for _, f := range failedTasks {
						fmt.Fprintf(w, "  - %s\n", f)
					}
				}
			}
		})
		return nil
	},
}

func buildTasklistCreateBody(runtime *common.RuntimeContext) map[string]interface{} {
	body := map[string]interface{}{
		"name": runtime.Str("name"),
	}

	if memberStr := runtime.Str("member"); memberStr != "" {
		ids := strings.Split(memberStr, ",")
		var members []map[string]interface{}
		for _, id := range ids {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			members = append(members, map[string]interface{}{
				"id":   id,
				"role": "editor",
				"type": "user",
			})
		}
		body["members"] = members
	}

	return body
}
