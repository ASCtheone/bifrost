// Package ui wraps native Windows dialogs (via zenity) for the small amount of
// text input a tray app needs: sign-in and provision-URL entry.
package ui

import (
	"strings"

	"github.com/ncruces/zenity"
)

const appTitle = "Bifrost VPN"

// PromptLogin shows a username/password dialog. ok is false if the user
// cancelled or left a field blank.
func PromptLogin() (username, password string, ok bool) {
	usr, pw, err := zenity.Password(
		zenity.Title("Sign in to Bifrost"),
		zenity.Username(),
	)
	if err != nil {
		return "", "", false
	}
	usr = strings.TrimSpace(usr)
	if usr == "" || pw == "" {
		return "", "", false
	}
	return usr, pw, true
}

// PromptProvisionURL asks the user to paste a provision URL.
func PromptProvisionURL() (url string, ok bool) {
	res, err := zenity.Entry(
		"Paste your Bifrost provision URL:",
		zenity.Title("Add device"),
		zenity.EntryText("https://"),
	)
	if err != nil {
		return "", false
	}
	res = strings.TrimSpace(res)
	if res == "" {
		return "", false
	}
	return res, true
}

// ShowError displays an error dialog.
func ShowError(msg string) {
	_ = zenity.Error(msg, zenity.Title(appTitle), zenity.ErrorIcon)
}

// ShowInfo displays an informational dialog.
func ShowInfo(msg string) {
	_ = zenity.Info(msg, zenity.Title(appTitle), zenity.InfoIcon)
}

// Confirm asks a yes/no question, returning true only on explicit confirmation.
func Confirm(msg string) bool {
	err := zenity.Question(msg, zenity.Title(appTitle), zenity.QuestionIcon)
	return err == nil // nil == OK/Yes; ErrCanceled == No
}
