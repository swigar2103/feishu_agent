// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package task

import (
	"testing"

	"github.com/smartystreets/goconvey/convey"
)

func TestBuildTlMembersBody(t *testing.T) {
	convey.Convey("Build with ids", t, func() {
		body := buildTlMembersBody("u1, u2 , ")
		members := body["members"].([]map[string]interface{})
		convey.So(len(members), convey.ShouldEqual, 2)
	})
}
