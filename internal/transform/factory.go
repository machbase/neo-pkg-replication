package transform

import (
	"repli/config"
	"repli/internal/ports"
	"repli/internal/transform/machbase"
)

func BuildPipeline(src, tar string, spec config.JobSpec) ([]ports.Transformer, error) {
	var chain []ports.Transformer

	// source ---> CIS
	switch src {
	case "machbase":
		chain = append(chain, machbase.NewMachbaseToCIS())
	case "postgres":
	}

	// CIS ---> CIS
	chain = append(chain, transoform?)

	// CIS ---> Target
	switch tar {
	case "machbase":
		chain = append(chain, machbase.NewCISTOMachbase())
	case "postgres":
	}

	return chain, nil
}
