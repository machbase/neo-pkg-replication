package main

import (
	"flag"
	"fmt"
	"os"
	"repli/config"
)

type Source interface {
	Read() ([][]any, error)
}

type Transform interface {
}

type Target interface {
	Write([][]any) error
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stdout, "Usage: ./program <command> [flag]\n\t<start>: program start\n")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "start":
		fs := flag.NewFlagSet("start", flag.ExitOnError)
		configPath := fs.String("config", "", "ex) ./program start -config=config.json")

		_ = fs.Parse(os.Args[2:])

		if *configPath == "" {
			fmt.Fprintln(os.Stderr, "error: -config is required")
			fs.Usage()
			os.Exit(2)
		}

		if err := run(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "run error: %v", err)
			os.Exit(2)
		}
	default:
		fmt.Fprintf(os.Stdout, "invalid command: %s", os.Args[1])
		os.Exit(1)
	}
}

func run(configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	fmt.Printf("config: %v", cfg)
	return nil
}

// config Load
//

// var errCh := make(chan error, 4)
// replicationNEO= func(source, target ) {
// if err := repli(source, target); err !=nil {
// errCh <- err
// }
// }

// for _, := range sources{
// replicationNEO(source1, target1)
// replicationNEO(source2, target2)
// replicationNEO(source3, target3)
// replicationNEO(source4, target4)
// }

// defer func () {close(errCh)}()

// for err := errCh {
// if err != nil {
// return err
// }
// }
