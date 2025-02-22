define([
    'underscore',
    'jquery',
    'knockout',
    'arches',
    'viewmodels/card-component',
    'viewmodels/alert',
    'chosen'
], function(_, $, ko, arches, CardComponentViewModel, AlertViewModel) {

    var flattenTree = function(parents, flatList) {
        _.each(ko.unwrap(parents), function(parent) {
            flatList.push(parent);
            flattenTree(
                ko.unwrap(parent.cards),
                flatList
            );
        }, this);
        return flatList;
    };

    function viewModel(params) {
        // params.form is the CardTreeViewModel
        var self = this;
        this.saving = false;
        this.tiles = [];

        params.configKeys = ['groupedCardIds'];
        CardComponentViewModel.apply(this, [params]);

        var cards;
        if (params.state === 'report') {
            cards = flattenTree(params.pageVm.report.cards, []);
        } else {
            cards = !!params.card.parent ? params.card.parent.cards : flattenTree(params.card.topCards, []);
        }
        this.cardLookup = {};
        this.subscriptions = {};
        this.siblingCards = ko.observableArray();

        _.each(cards, function(card) {
            this.cardLookup[card.model.id] = card;
            if (card.parentCard === params.card.parentCard &&
                card.model.cardinality() === '1' &&
                card !== params.card &&
                card.cards().length === 0) {
                this.siblingCards.push({'name': card.model.name(), 'id': card.model.id});
            }
        }, this);

        this.groupedCards = ko.computed(function(){
            var gc = _.map([this.card.model.id].concat(this.groupedCardIds()), function(cardid) {
                var card = this.cardLookup[cardid];
                var subscription = card.model.cardinality.subscribe(function(cardinality){
                    if (cardinality !== '1') {
                        card.model.cardinality('1');
                        var errorTitle = 'Settings Conflict: Remove this card from grouped card?';
                        var errorMesssage = 'The cardinality of this card can\'t be changed until you remove it from being grouped with the "' + self.card.model.name() + '" card.  Do you want to remove this card from being grouped with the "' + self.card.model.name() + '" card';
                        params.pageVm.alert(new AlertViewModel('ep-alert-red', errorTitle, errorMesssage, function(){}, function(){
                            var newgroup = _.filter(self.groupedCardIds(), function(cardid) {
                                return cardid !== card.model.id;
                            });
                            self.groupedCardIds(newgroup);
                            self.subscriptions[cardid].dispose();
                            card.model.cardinality('n');
                            self.card.model.save();
                        }));
                    }
                }, this);
                this.subscriptions[cardid] = subscription;
                return card;
            }, this);

            return gc;
        }, this);

        if (!!params.preview) {
            _.each(this.groupedCards(), function(card) {
                if (card.tiles().length === 0) {
                    card.tiles.push(card.getNewTile());
                }
                // we do this so that when you select a grouped widget
                // the selectedCard remains the same and doesn't jump to it's true card
                _.each(card.widgets(), function(widget) {
                    widget.parent = self.card;
                });
            }, this);
        }

        this.groupedTiles = ko.computed(function() {
            if (this.saving) {
                return this.tiles;
            } else {
                var tiles = [];
                _.each(this.groupedCards(), function(card) {
                    if (card.tiles().length > 0) {
                        tiles.push(card.tiles()[0]);
                    } else {
                        tiles.push(card.getNewTile());
                    }
                }, this);
                this.tiles = tiles;
                return tiles;
            }
        }, this);

        this.getTile = function(cardid) {
            var tile = _.find(this.groupedTiles(), function(tile) {
                return tile.parent.model.id === cardid;
            });
            if (!tile && !!params.preview) {
                tile = self.cardLookup[cardid].getNewTile();
            }
            return tile;
        };

        this.dirty = ko.computed(function() {
            return _.find(this.groupedTiles(), function(tile) {
                return tile.dirty();
            }, this);
        }, this);

        this.previouslySaved = ko.computed(function() {
            return !!(_.find(this.groupedTiles(), function(tile) {
                return !!tile.tileid;
            }, this));
        }, this);

        this.saveTiles = function(){
            var self = this;
            var errors = ko.observableArray().extend({ rateLimit: 250 });
            var tiles = this.groupedTiles();
            var tile = this.groupedTiles()[0];
            this.saving = true;
            tile.save(function(response) {
                errors.push(response);
                self.saving = false;
                self.groupedCardIds.valueHasMutated();
                self.selectGroupCard();
            }, function(response){
                var resourceInstanceId = response.resourceinstance_id;
                var requests = _.map(_.rest(tiles), function(tile) {
                    tile.resourceinstance_id = resourceInstanceId;
                    return tile.save(function(response) {
                        errors.push(response);
                    });
                }, self);
                Promise.all(requests).finally(function(){
                    self.saving = false;
                    self.groupedCardIds.valueHasMutated();
                    self.selectGroupCard();
                    if (params.form.onSaveSuccess) {
                        params.form.onSaveSuccess(self.tiles);
                    }
                    self.loading(false);
                });
            });
            errors.subscribe(function(errors){
                var title = [];
                var message = [];
                errors.forEach(function(response) {
                    title.push(response.responseJSON.message[0]);
                    message.push(response.responseJSON.message[1]);
                });
                params.pageVm.alert(new AlertViewModel('ep-alert-red', title.join(), message.join(), null, function(){}));
                if (params.form.onSaveError) {
                    params.form.onSaveError(self.tile);
                }
            });
        };

        this.deleteTiles = function(){
            params.loading(true);
            var self = this;
            var errors = ko.observableArray().extend({ rateLimit: 250 });

            var requests = self.groupedTiles().map(function(tile) {
                if (!!tile.tileid) {
                    return $.ajax({
                        type: "DELETE",
                        url: arches.urls.tile,
                        data: JSON.stringify(tile.getData())
                    }).done(function(response) {
                        tile.parent.tiles.remove(tile);
                    }).fail(function(response) {
                        errors.push(response);
                    });
                }
            }, self);

            Promise.all(requests).finally(function(){
                params.loading(false);
                self.selectGroupCard();
            });
            errors.subscribe(function(errors){
                var title = [];
                var message = [];
                errors.forEach(function(response) {
                    title.push(response.responseJSON.message[0]);
                    message.push(response.responseJSON.message[1]);
                });
                params.pageVm.alert(new AlertViewModel('ep-alert-red', title.join(), message.join(), null, function(){}));
            });

        };

        this.resetTiles = function(){
            _.each(this.groupedTiles(), function(tile) {
                tile.reset();
            }, this);
        };

        this.selectGroupCard = function() {
            this.card.selected(true);
        };
    }

    ko.components.register('grouping-card-component', {
        viewModel: viewModel,
        template: {
            require: 'text!templates/views/components/cards/grouping.htm'
        }
    });
    return viewModel;
});
