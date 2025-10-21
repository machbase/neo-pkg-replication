PACKAGE_NAME=repli
CMD_DIR=cmd
CONFIG_DIR=config
CONFIG_FILE=config.yaml
BIN_DIR=bin

run:
	@echo "Running $(PACKAGE_NAME)..."
	go run ./$(CMD_DIR)/$(PACKAGE_NAME) start --config $(CONFIG_DIR)/$(CONFIG_FILE)

build:
	@echo "Building $(PACKAGE_NAME)..."
	@mkdir -p ./$(BIN_DIR)/$(PACKAGE_NAME)
	go build -o $(BIN_DIR)/$(PACKAGE_NAME)/$(PACKAGE_NAME) ./$(CMD_DIR)/$(PACKAGE_NAME)

clean:
	@echo "Cleaning $(BIN_DIR)/$(PACKAGE_NAME)"
	@rm -rf ./$(BIN_DIR)

package: clean build
	@echo "Packging $(PACKAGE_NAME)..."
	@cp $(CONFIG_DIR)/$(CONFIG_FILE) $(BIN_DIR)/$(PACKAGE_NAME)/$(CONFIG_FILE)
	@cd $(BIN_DIR) && zip $(PACKAGE_NAME).zip $(PACKAGE_NAME)/*

.PHONY: run build